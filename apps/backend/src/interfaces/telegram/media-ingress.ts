import fs from "node:fs";
import type { Bot } from "grammy";
import { importStudioMediaFile } from "../../content/index.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { downloadTelegramFile } from "./file-download.js";

/** Converts Telegram transport file ids into Content-owned assets before a draft is written. */
export async function importTelegramAlbumMedia(
  bot: Bot,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  media: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (typeof bot.api.getFile !== "function") return media; // compatibility for historical/test-only ingress.
  return Promise.all(media.map((item) => importTelegramMediaItem(bot, backendDb, config, actorId, item)));
}

async function importTelegramMediaItem(
  bot: Bot,
  backendDb: BackendDb,
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
  const downloaded = await downloadTelegramFile(config, file.file_path, extension);
  let asset: Awaited<ReturnType<typeof importStudioMediaFile>>;
  try {
    asset = await importStudioMediaFile(backendDb, config, actorId, {
      filename: `telegram-${fileId}${extension}`,
      contentType: type === "video" ? "video/mp4" : "image/jpeg",
      localPath: downloaded.path,
      source: "telegram_upload",
    });
  } finally {
    if (downloaded.temporary) await fs.promises.rm(downloaded.path, { force: true });
  }
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
