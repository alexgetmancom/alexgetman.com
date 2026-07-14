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
  if (photo) media.push({ type: "photo", file_id: photo.file_id, width: photo.width, height: photo.height });
  if (message && "video" in message && message.video) {
    media.push({
      type: "video",
      file_id: message.video.file_id,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
    });
  }
  return { text, media, entities };
}
