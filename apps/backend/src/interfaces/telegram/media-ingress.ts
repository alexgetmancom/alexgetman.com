import fs from "node:fs";
import path from "node:path";
import type { Bot } from "grammy";
import { importStudioMediaAsset } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";

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
  const bytes = await telegramFileBytes(config, file.file_path);
  const asset = await importStudioMediaAsset(backendDb, config, actorId, {
    filename: `telegram-${fileId}${extension}`,
    contentType: type === "video" ? "video/mp4" : "image/jpeg",
    bytes,
    source: "telegram_upload",
  });
  return {
    ...item,
    asset_id: asset.id,
    local_path: asset.localPath,
    filename: asset.filename,
    mime_type: asset.mimeType,
  };
}

async function telegramFileBytes(config: BackendConfig, filePath: string): Promise<Uint8Array> {
  if (path.isAbsolute(filePath)) return new Uint8Array(await fs.promises.readFile(filePath));
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  const url = `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/file/bot${config.controllerBotToken}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Telegram media download failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function string(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
