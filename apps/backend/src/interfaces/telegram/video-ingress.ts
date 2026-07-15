import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Context } from "grammy";
import { importStudioMediaFile } from "../../content/assets.js";
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
  let localPath = apiFile.file_path;
  let temporaryPath: string | null = null;
  if (!path.isAbsolute(localPath)) {
    const url = `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/file/bot${config.controllerBotToken}/${apiFile.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram video download failed: ${response.status}`);
    temporaryPath = path.join(config.STUDIO_MEDIA_DIR, ".incoming", `telegram-video-${crypto.randomUUID()}${extension.toLowerCase()}`);
    await fs.promises.mkdir(path.dirname(temporaryPath), { recursive: true });
    await Bun.write(temporaryPath, response);
    localPath = temporaryPath;
  }
  let asset: Awaited<ReturnType<typeof importStudioMediaFile>>;
  try {
    asset = await importStudioMediaFile(backendDb, config, adminId, {
      filename: name || `telegram-video${extension.toLowerCase()}`,
      contentType: mime || "video/mp4",
      localPath,
      source: "telegram_upload",
    });
  } finally {
    if (temporaryPath) await fs.promises.rm(temporaryPath, { force: true });
  }
  if (asset.kind !== "video") throw new Error("Only MP4 video files are supported.");
  return { assetId: asset.id };
}
