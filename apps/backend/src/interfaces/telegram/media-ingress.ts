import type { Bot } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { createStudioServices, type StudioServices } from "../../studio/services/index.js";
import { importTelegramAsset } from "./media-import.js";

/** Converts Telegram transport file ids into Content-owned assets before a draft is written. */
export async function importTelegramAlbumMedia(
  bot: Bot,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  media: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const studioMedia = createStudioServices(backendDb, config).media;
  return Promise.all(media.map((item) => importTelegramMediaItem(bot, studioMedia, config, actorId, item)));
}

async function importTelegramMediaItem(
  bot: Bot,
  studioMedia: StudioServices["media"],
  config: BackendConfig,
  actorId: number,
  item: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (item.asset_id != null || item.local_path != null || item.localPath != null) return item;
  const fileId = string(item.file_id) ?? string(item.fileId);
  if (!fileId) throw new Error("Telegram media item has no file id.");
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a media file path.");
  const type = String(item.type ?? "photo").toLowerCase();
  const extension = type === "video" ? ".mp4" : ".jpg";
  const asset = await importTelegramAsset(studioMedia, config, actorId, file.file_path, {
    extension,
    filename: `telegram-${fileId}${extension}`,
    contentType: type === "video" ? "video/mp4" : "image/jpeg",
  });
  return {
    ...item,
    asset_id: asset.id,
    local_path: asset.localPath,
    filename: asset.filename,
    mime_type: asset.mimeType,
  };
}

function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
