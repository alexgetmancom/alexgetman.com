import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { Context } from "grammy";
import type { BackendConfig } from "../config.js";

type StoredVideo = { assetKey: string; sourcePath: string; publicUrl: string; sizeBytes: number };

export async function storeTelegramVideo(ctx: Context, config: BackendConfig): Promise<StoredVideo> {
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
  const assetKey = crypto.randomBytes(24).toString("base64url");
  mkdirSync(config.VIDEO_MEDIA_DIR, { recursive: true });
  const extension = path.extname(name) || ".mp4";
  const sourcePath = path.join(config.VIDEO_MEDIA_DIR, `${assetKey}${extension.toLowerCase()}`);

  let sizeBytes = 0;
  if (path.isAbsolute(apiFile.file_path)) {
    copyFileSync(apiFile.file_path, sourcePath);
    sizeBytes = statSync(sourcePath).size;
  } else {
    const url = `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/file/bot${config.controllerBotToken}/${apiFile.file_path}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Telegram video download failed: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await Bun.write(sourcePath, bytes);
    sizeBytes = bytes.byteLength;
  }
  return {
    assetKey,
    sourcePath,
    publicUrl: `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/media/video/${assetKey}`,
    sizeBytes,
  };
}

export function videoPath(config: BackendConfig, assetKey: string): string | null {
  if (!existsSync(config.VIDEO_MEDIA_DIR)) return null;
  const match = readdirSync(config.VIDEO_MEDIA_DIR).find((entry) => entry.startsWith(`${assetKey}.`));
  return match ? path.join(config.VIDEO_MEDIA_DIR, match) : null;
}

export function deleteVideo(config: BackendConfig, assetKey: string): void {
  const file = videoPath(config, assetKey);
  if (file) rmSync(file, { force: true });
}
