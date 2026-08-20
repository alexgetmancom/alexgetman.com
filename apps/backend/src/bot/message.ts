import type { Context } from "grammy";
import type { DraftMessage } from "../content/message.js";

export function extractMessage(ctx: Context): DraftMessage {
  const message = ctx.message;
  const text = message && "text" in message ? (message.text ?? "") : message && "caption" in message ? (message.caption ?? "") : "";
  const entities =
    message && "entities" in message
      ? (message.entities ?? [])
      : message && "caption_entities" in message
        ? (message.caption_entities ?? [])
        : [];
  const media: Record<string, unknown>[] = [];
  const photos = message && "photo" in message ? message.photo : undefined;
  const photo = photos?.at(-1);
  if (photo) media.push({ type: "photo", file_id: photo.file_id, width: photo.width, height: photo.height, file_size: photo.file_size });
  if (message && "video" in message && message.video) {
    media.push({
      type: "video",
      file_id: message.video.file_id,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
      file_size: message.video.file_size,
    });
  }
  if (message && "animation" in message && message.animation) {
    media.push({
      type: "video",
      file_id: message.animation.file_id,
      width: message.animation.width,
      height: message.animation.height,
      duration: message.animation.duration,
      file_name: message.animation.file_name,
      mime_type: message.animation.mime_type,
      file_size: message.animation.file_size,
    });
  }
  const document = message && "document" in message ? message.document : undefined;
  const documentName = document?.file_name ?? "";
  const documentMimeType = document?.mime_type ?? "";
  if (document && (documentMimeType.toLowerCase().startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|gif)$/i.test(documentName))) {
    media.push({
      type: "video",
      file_id: document.file_id,
      file_name: documentName || undefined,
      mime_type: documentMimeType || undefined,
      file_size: document.file_size,
    });
  }
  return { text, media, entities };
}
