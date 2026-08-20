import path from "node:path";
import type { Context } from "grammy";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { createStudioServices, type StudioServices } from "../../studio/services/index.js";
import { importTelegramAsset } from "./media-import.js";

type StoredVideo = { assetId: number };

/** A video Telegram already accepted, carried by id rather than by the message
 * that brought it: the intake stores the file only once the operator has said
 * it is a video publication, which is a later update than the upload. */
export type TelegramVideoFile = { fileId: string; name: string; mime: string };

/** Telegram-only adapter that receives an uploaded video into Content storage. */
export async function storeTelegramVideo(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  source?: TelegramVideoFile,
): Promise<StoredVideo> {
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  const video = ctx.message && "video" in ctx.message ? ctx.message.video : undefined;
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  const message = video ?? document;
  const file =
    source ??
    (message && "file_id" in message
      ? {
          fileId: message.file_id,
          name: "file_name" in message ? (message.file_name ?? "") : "",
          mime: "mime_type" in message ? (message.mime_type ?? "") : "",
        }
      : null);
  if (!file) throw new StudioError("err.send-mp4");
  const { mime, name } = file;
  // A document is only a video when it says so; a `video` message already is one.
  const declared = source !== undefined || video !== undefined;
  if (!declared && !mime.startsWith("video/") && !name.toLowerCase().endsWith(".mp4")) throw new StudioError("err.only-video");
  const apiFile = await ctx.api.getFile(file.fileId);
  if (!apiFile.file_path) throw new Error("Telegram did not return a file path.");
  const extension = path.extname(name) || ".mp4";
  const studioMedia: StudioServices["media"] = createStudioServices(backendDb, config).media;
  const asset = await importTelegramAsset(studioMedia, config, actorId, apiFile.file_path, {
    extension: extension.toLowerCase(),
    filename: name || `telegram-video${extension.toLowerCase()}`,
    contentType: mime || "video/mp4",
  });
  if (asset.kind !== "video") throw new StudioError("err.only-mp4");
  return { assetId: asset.id };
}
