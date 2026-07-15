import { readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "grammy";
import { importStudioMediaAsset } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";

type StoredVideo = { assetId: number };

/** Telegram-only adapter that receives an uploaded video into Content storage. */
export async function storeTelegramVideo(ctx: Context, backendDb: BackendDb, config: BackendConfig, adminId: number): Promise<StoredVideo> {
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  const video = ctx.message && "video" in ctx.message ? ctx.message.video : undefined;
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  const file = video ?? document;
  if (!file || !("file_id" in file)) throw new Error("Send an MP4 video file.");
  const mime = "mime_type" in file ? (file.mime_type ?? "") : "";
  const name = "file_name" in file ? (file.file_name ?? "") : "";
  if (document && !mime.startsWith("video/") && !name.toLowerCase().endsWith(".mp4")) throw new Error("Only video files are supported.");
  const apiFile = await ctx.api.getFile(file.file_id);
  if (!apiFile.file_path) throw new Error("Telegram did not return a file path.");
  const extension = path.extname(name) || ".mp4";
  let bytes: Uint8Array;
  if (path.isAbsolute(apiFile.file_path)) {
    bytes = new Uint8Array(readFileSync(apiFile.file_path));
  } else {
    const url = `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/file/bot${config.controllerBotToken}/${apiFile.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram video download failed: ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const asset = await importStudioMediaAsset(backendDb, config, adminId, {
    filename: name || `telegram-video${extension.toLowerCase()}`,
    contentType: mime || "video/mp4",
    bytes,
    source: "telegram_upload",
  });
  if (asset.kind !== "video") throw new Error("Only MP4 video files are supported.");
  return { assetId: asset.id };
}
