import fs from "node:fs";
import path from "node:path";
import type { Context } from "grammy";
import { importStudioMediaFile } from "../../content/index.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { downloadTelegramFile } from "./file-download.js";

type StoredVideo = { assetId: number };

/** Telegram-only adapter that receives an uploaded video into Content storage. */
export async function storeTelegramVideo(ctx: Context, backendDb: BackendDb, config: BackendConfig, actorId: number): Promise<StoredVideo> {
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  const video = ctx.message && "video" in ctx.message ? ctx.message.video : undefined;
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  const file = video ?? document;
  if (!file || !("file_id" in file)) throw new StudioError("err.send-mp4");
  const mime = "mime_type" in file ? (file.mime_type ?? "") : "";
  const name = "file_name" in file ? (file.file_name ?? "") : "";
  if (document && !mime.startsWith("video/") && !name.toLowerCase().endsWith(".mp4")) throw new StudioError("err.only-video");
  const apiFile = await ctx.api.getFile(file.file_id);
  if (!apiFile.file_path) throw new Error("Telegram did not return a file path.");
  const extension = path.extname(name) || ".mp4";
  const downloaded = await downloadTelegramFile(config, apiFile.file_path, extension.toLowerCase());
  let asset: Awaited<ReturnType<typeof importStudioMediaFile>>;
  try {
    asset = await importStudioMediaFile(backendDb, config, actorId, {
      filename: name || `telegram-video${extension.toLowerCase()}`,
      contentType: mime || "video/mp4",
      localPath: downloaded.path,
      source: "telegram_upload",
    });
  } finally {
    if (downloaded.temporary) await fs.promises.rm(downloaded.path, { force: true });
  }
  if (asset.kind !== "video") throw new StudioError("err.only-mp4");
  return { assetId: asset.id };
}
