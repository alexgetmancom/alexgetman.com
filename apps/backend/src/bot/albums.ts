import { asc, eq, lte } from "drizzle-orm";
import type { Bot } from "grammy";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { drafts, pendingAlbums } from "../db/schema.js";
import { log } from "../logger.js";
import { translateToEnglish } from "../translation.js";
import { clearAdminState } from "./callbacks.js";
import { createDraftFromMessage } from "./drafts.js";
import { parseArrayValue } from "./message.js";
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
      set: { textRu: values.textRu, textEntitiesJson: values.textEntitiesJson, mediaJson: values.mediaJson, updatedAt: now },
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
    .where(lte(pendingAlbums.updatedAt, cutoff))
    .orderBy(asc(pendingAlbums.updatedAt))
    .all();
  let completed = 0;
  for (const row of rows) {
    try {
      const media = parseArrayValue(row.mediaJson);
      const draftId = row.draftId;
      if ((row.action === "replace_ru_media" || row.action === "replace_en_media") && draftId) {
        backendDb.db
          .update(drafts)
          .set(
            row.action === "replace_ru_media"
              ? { mediaRuJson: JSON.stringify(media), updatedAt: new Date().toISOString() }
              : { mediaEnJson: JSON.stringify(media), updatedAt: new Date().toISOString() },
          )
          .where(eq(drafts.id, draftId))
          .run();
        clearAdminState(backendDb, row.adminId);
        const preview = draftPreview(backendDb, draftId);
        await bot.api.sendMessage(row.chatId, preview.text, { reply_markup: preview.keyboard });
      } else {
        const text = row.textRu;
        let textEn = text;
        try {
          textEn = await translateToEnglish(text, config);
        } catch {
          textEn = "";
        }
        const created = createDraftFromMessage(backendDb, row.adminId, {
          text,
          textEn,
          media,
          entities: parseArrayValue(row.textEntitiesJson),
        });
        const preview = draftPreview(backendDb, created);
        await bot.api.sendMessage(row.chatId, preview.text, { reply_markup: preview.keyboard });
      }
      backendDb.db.delete(pendingAlbums).where(eq(pendingAlbums.id, row.id)).run();
      completed += 1;
    } catch (error) {
      log("error", "album finalization failed", { album: row.id, error: String(error) });
    }
  }
  return completed;
}
