import { and, asc, eq, lte } from "drizzle-orm";
import type { Bot } from "grammy";
import { parseArrayValue } from "../content/message.js";
import { translateToEnglish } from "../content/translation.js";
import type { BackendDb } from "../db/client.js";
import { pendingAlbums } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { setTelegramPostCard, telegramPostCard } from "../interfaces/telegram/control-cards.js";
import { importTelegramAlbumMedia } from "../interfaces/telegram/media-ingress.js";
import { studioServices } from "../studio/services/index.js";
import { clearPostAdminStateIfCurrent } from "./post-state.js";
import { draftPreview } from "./preview.js";

type PendingAlbumInput = {
  adminId: number;
  chatId: number;
  mediaGroupId: string;
  text: string;
  entities: unknown[];
  media: Record<string, unknown>;
  action: string | null;
  draftId: number | null;
};

export function appendPendingAlbum(backendDb: BackendDb, input: PendingAlbumInput): boolean {
  const id = `${input.adminId}:${input.chatId}:${input.mediaGroupId}:${input.action ?? "draft"}:${input.draftId ?? ""}`;
  const row = backendDb.db
    .select({ mediaJson: pendingAlbums.mediaJson, textRu: pendingAlbums.textRu, textEntitiesJson: pendingAlbums.textEntitiesJson })
    .from(pendingAlbums)
    .where(eq(pendingAlbums.id, id))
    .get();
  const media = row ? parseArrayValue(row.mediaJson) : [];
  media.push(input.media);
  const now = new Date().toISOString();
  const values = {
    id,
    adminId: input.adminId,
    chatId: input.chatId,
    mediaGroupId: input.mediaGroupId,
    action: input.action,
    draftId: input.draftId,
    textRu: input.text || row?.textRu || "",
    textEntitiesJson: JSON.stringify(input.entities.length ? input.entities : parseArrayValue(row?.textEntitiesJson)),
    mediaJson: JSON.stringify(media),
    notified: 1,
    updatedAt: now,
  };
  backendDb.db
    .insert(pendingAlbums)
    .values(values)
    .onConflictDoUpdate({
      target: pendingAlbums.id,
      set: {
        textRu: values.textRu,
        textEntitiesJson: values.textEntitiesJson,
        mediaJson: values.mediaJson,
        notified: 1,
        updatedAt: now,
      },
    })
    .run();
  return !row;
}

export async function finalizePendingAlbums(bot: Bot | null, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  const cutoff = new Date(Date.now() - config.CONTROLLER_ALBUM_SETTLE_SECONDS * 1000).toISOString();
  const rows = backendDb.db
    .select({
      id: pendingAlbums.id,
      adminId: pendingAlbums.adminId,
      chatId: pendingAlbums.chatId,
      action: pendingAlbums.action,
      draftId: pendingAlbums.draftId,
      textRu: pendingAlbums.textRu,
      textEntitiesJson: pendingAlbums.textEntitiesJson,
      mediaJson: pendingAlbums.mediaJson,
    })
    .from(pendingAlbums)
    .where(and(eq(pendingAlbums.notified, 1), lte(pendingAlbums.updatedAt, cutoff)))
    .orderBy(asc(pendingAlbums.updatedAt))
    .all();
  let completed = 0;
  for (const row of rows) {
    const claim = backendDb.db
      .update(pendingAlbums)
      .set({ notified: 2 })
      .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, 1), lte(pendingAlbums.updatedAt, cutoff)))
      .returning({ id: pendingAlbums.id })
      .get();
    if (!claim) continue;
    try {
      const media = await importTelegramAlbumMedia(bot, backendDb, config, row.adminId, parseArrayValue(row.mediaJson));
      const draftId = row.draftId;
      const isEdit = row.action === "edit_ru" || row.action === "edit_en";
      const isMediaReplacement = row.action === "replace_ru_media" || row.action === "replace_en_media";
      if ((isEdit || isMediaReplacement) && draftId) {
        studioServices(backendDb, config).posts.edit(row.adminId, draftId, {
          locale: row.action === "edit_ru" || row.action === "replace_ru_media" ? "ru" : "en",
          text: isMediaReplacement ? "" : row.textRu,
          entities: isMediaReplacement ? [] : parseArrayValue(row.textEntitiesJson),
          media,
          ...(isMediaReplacement ? { replaceMediaOnly: true } : {}),
        });
        clearPostAdminStateIfCurrent(backendDb, row.adminId, row.action, draftId);
        await refreshDraftControlCard(bot, backendDb, config, row.adminId, draftId, row.chatId);
      } else {
        const text = row.textRu;
        let textEn = text;
        try {
          textEn = await translateToEnglish(text, config);
        } catch {
          textEn = "";
        }
        const created = studioServices(backendDb, config).posts.create(row.adminId, {
          text,
          textEn,
          media,
          entities: parseArrayValue(row.textEntitiesJson),
        });
        await refreshDraftControlCard(bot, backendDb, config, row.adminId, created, row.chatId);
        clearPostAdminStateIfCurrent(backendDb, row.adminId, row.action, row.draftId);
      }
      const removed = backendDb.db
        .delete(pendingAlbums)
        .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, 2)))
        .returning({ id: pendingAlbums.id })
        .get();
      if (removed) completed += 1;
    } catch (error) {
      backendDb.db
        .update(pendingAlbums)
        .set({ notified: 1, updatedAt: new Date().toISOString() })
        .where(and(eq(pendingAlbums.id, row.id), eq(pendingAlbums.notified, 2)))
        .run();
      log("error", "album finalization failed", { album: row.id, error: String(error) });
    }
  }
  return completed;
}

async function refreshDraftControlCard(
  bot: Bot,
  backendDb: BackendDb,
  _config: BackendConfig,
  _adminId: number,
  draftId: number,
  chatId: number,
): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  const card = telegramPostCard(backendDb, draftId);
  if (card)
    try {
      await bot.api.editMessageText(card.chatId, card.messageId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
      return;
    } catch (error) {
      log("warn", "draft control card could not be edited; sending a replacement", { draftId, error: String(error) });
    }
  const control = await bot.api.sendMessage(chatId, preview.text, { parse_mode: "Markdown", reply_markup: preview.keyboard });
  setTelegramPostCard(backendDb, draftId, chatId, control.message_id);
}
