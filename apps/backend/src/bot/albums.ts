import { and, asc, eq, lte } from "drizzle-orm";
import type { Bot } from "grammy";
import { parseArrayValue } from "../content/message.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { pendingAlbums } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { setTelegramPostCard } from "../interfaces/telegram/control-cards.js";
import { importTelegramAlbumMedia } from "../interfaces/telegram/media-ingress.js";
import { createStudioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";
import { clearPostAdminStateIfCurrent, getPostAdminState } from "./post-state.js";
import { translatePostText } from "./post-translation.js";
import { draftPreview } from "./preview.js";

// pending_albums.notified lifecycle: an album is SETTLED once its caption and
// media are collected, then CLAIMED by exactly one worker before finalization.
const ALBUM_SETTLED = 1;
const ALBUM_CLAIMED = 2;
// A claim is durable so a process crash cannot lose the album, but it needs a
// lease so a claim abandoned mid-import can be picked up by the next cycle.
const ALBUM_CLAIM_LEASE_MS = 10 * 60_000;
// A failed finalization goes back to SETTLED and is retried once per settle
// window. Deterministic failures (an expired file_id, a draft deleted mid-flight)
// would loop forever, so give up after a few tries and tell the sender instead
// of retrying silently at ~1 Hz.
const ALBUM_MAX_ATTEMPTS = 5;

type PendingAlbumInput = {
  actorId: number;
  chatId: number;
  mediaGroupId: string;
  text: string;
  entities: unknown[];
  media: Record<string, unknown>;
  action: string | null;
  draftId: number | null;
  stateRevision: number | null;
};

export function appendPendingAlbum(backendDb: BackendDb, input: PendingAlbumInput): boolean {
  const id = `${input.actorId}:${input.chatId}:${input.mediaGroupId}:${input.action ?? "draft"}:${input.draftId ?? ""}`;
  const row = unsafeDb(backendDb)
    .db.select({ mediaJson: pendingAlbums.mediaJson, textRu: pendingAlbums.textRu, textEntitiesJson: pendingAlbums.textEntitiesJson })
    .from(pendingAlbums)
    .where(eq(pendingAlbums.id, id))
    .get();
  const media = row ? parseArrayValue(row.mediaJson) : [];
  media.push(input.media);
  const now = new Date().toISOString();
  const values = {
    id,
    actorId: input.actorId,
    chatId: input.chatId,
    mediaGroupId: input.mediaGroupId,
    action: input.action,
    draftId: input.draftId,
    stateRevision: input.stateRevision,
    textRu: input.text || row?.textRu || "",
    textEntitiesJson: JSON.stringify(input.entities.length ? input.entities : parseArrayValue(row?.textEntitiesJson)),
    mediaJson: JSON.stringify(media),
    notified: ALBUM_SETTLED,
    updatedAt: now,
  };
  unsafeDb(backendDb)
    .db.insert(pendingAlbums)
    .values(values)
    .onConflictDoUpdate({
      target: pendingAlbums.id,
      set: {
        textRu: values.textRu,
        textEntitiesJson: values.textEntitiesJson,
        mediaJson: values.mediaJson,
        notified: ALBUM_SETTLED,
        updatedAt: now,
      },
    })
    .run();
  return !row;
}

export async function finalizePendingAlbums(bot: Bot | null, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  const now = new Date();
  const nowIso = now.toISOString();
  const claimCutoff = new Date(now.getTime() - ALBUM_CLAIM_LEASE_MS).toISOString();
  // Recover claims left behind by a crashed worker. Keep updatedAt untouched:
  // the row can be selected in this same cycle if its settle window elapsed.
  unsafeDb(backendDb)
    .db.update(pendingAlbums)
    .set({ notified: ALBUM_SETTLED })
    .where(and(eq(pendingAlbums.notified, ALBUM_CLAIMED), lte(pendingAlbums.updatedAt, claimCutoff)))
    .run();
  const cutoff = new Date(now.getTime() - config.CONTROLLER_ALBUM_SETTLE_SECONDS * 1000).toISOString();
  const rows = unsafeDb(backendDb)
    .db.select({
      id: pendingAlbums.id,
      actorId: pendingAlbums.actorId,
      chatId: pendingAlbums.chatId,
      action: pendingAlbums.action,
      draftId: pendingAlbums.draftId,
      stateRevision: pendingAlbums.stateRevision,
      attemptCount: pendingAlbums.attemptCount,
      textRu: pendingAlbums.textRu,
      textEntitiesJson: pendingAlbums.textEntitiesJson,
      mediaJson: pendingAlbums.mediaJson,
    })
    .from(pendingAlbums)
    .where(and(eq(pendingAlbums.notified, ALBUM_SETTLED), lte(pendingAlbums.updatedAt, cutoff)))
    .orderBy(asc(pendingAlbums.updatedAt))
    .all();
  let completed = 0;
  for (const row of rows) {
    const claim = unsafeDb(backendDb)
      .db.update(pendingAlbums)
      .set({ notified: ALBUM_CLAIMED, updatedAt: nowIso })
      .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_SETTLED), lte(pendingAlbums.updatedAt, cutoff)))
      .returning({ id: pendingAlbums.id })
      .get();
    if (!claim) continue;
    try {
      if (row.stateRevision != null && getPostAdminState(backendDb, row.actorId)?.revision !== row.stateRevision) {
        unsafeDb(backendDb)
          .db.delete(pendingAlbums)
          .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_CLAIMED)))
          .run();
        log("warn", "stale album discarded", { album: row.id, actorId: row.actorId, stateRevision: row.stateRevision });
        continue;
      }
      const media = await importTelegramAlbumMedia(bot, backendDb, config, row.actorId, parseArrayValue(row.mediaJson));
      const draftId = row.draftId;
      const isEdit = row.action === "edit_ru" || row.action === "edit_en";
      const isMediaReplacement = row.action === "replace_ru_media" || row.action === "replace_en_media";
      if ((isEdit || isMediaReplacement) && draftId) {
        createStudioServices(backendDb, config).posts.edit(row.actorId, draftId, {
          locale: row.action === "edit_ru" || row.action === "replace_ru_media" ? "ru" : "en",
          text: isMediaReplacement ? "" : row.textRu,
          entities: isMediaReplacement ? [] : parseArrayValue(row.textEntitiesJson),
          media,
          ...(isMediaReplacement ? { replaceMediaOnly: true } : {}),
        });
        clearPostAdminStateIfCurrent(backendDb, row.actorId, row.action, draftId, row.stateRevision);
        await refreshDraftControlCard(bot, backendDb, config, row.actorId, draftId, row.chatId);
      } else {
        const text = row.textRu;
        const textEn = await translatePostText(text, config);
        const created = createStudioServices(backendDb, config).publications.create(row.actorId, {
          kind: "post",
          message: { text, textEn, media, entities: parseArrayValue(row.textEntitiesJson) },
        }).id;
        await refreshDraftControlCard(bot, backendDb, config, row.actorId, created, row.chatId);
        clearPostAdminStateIfCurrent(backendDb, row.actorId, row.action, row.draftId, row.stateRevision);
      }
      const removed = unsafeDb(backendDb)
        .db.delete(pendingAlbums)
        .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_CLAIMED)))
        .returning({ id: pendingAlbums.id })
        .get();
      if (removed) completed += 1;
    } catch (error) {
      const attempts = row.attemptCount + 1;
      const exhausted = attempts >= ALBUM_MAX_ATTEMPTS;
      if (exhausted) {
        unsafeDb(backendDb).db.delete(pendingAlbums).where(eq(pendingAlbums.id, row.id)).run();
        await notifyAlbumGaveUp(bot, backendDb, row.actorId, row.chatId);
      } else {
        unsafeDb(backendDb)
          .db.update(pendingAlbums)
          .set({ notified: ALBUM_SETTLED, attemptCount: attempts, updatedAt: new Date().toISOString() })
          .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, ALBUM_CLAIMED)))
          .run();
      }
      log(exhausted ? "error" : "warn", "album finalization failed", {
        album: row.id,
        attempts,
        exhausted,
        error: String(error),
      });
    }
  }
  return completed;
}

/** Last word on an album that will never become a draft. Best-effort: a failed
 * notification must not resurrect the row we just dropped. */
async function notifyAlbumGaveUp(bot: Bot, backendDb: BackendDb, actorId: number, chatId: number): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, t(botLocale(backendDb, actorId), "post.album-failed"));
  } catch (error) {
    log("warn", "album give-up notice failed", { chat: chatId, error: String(error) });
  }
}

async function refreshDraftControlCard(
  bot: Bot,
  backendDb: BackendDb,
  config: BackendConfig,
  _actorId: number,
  draftId: number,
  chatId: number,
): Promise<void> {
  const preview = draftPreview(backendDb, draftId, config);
  // A completed chat edit gets a fresh card at the bottom. Previous cards are
  // history, never a moving conversation prompt above the user's reply.
  const control = await bot.api.sendMessage(chatId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  setTelegramPostCard(backendDb, draftId, chatId, control.message_id);
}
