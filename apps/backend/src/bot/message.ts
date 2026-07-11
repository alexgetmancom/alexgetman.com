import type { Context } from "grammy";
import { DEFAULT_TARGETS } from "../botTargets.js";
import { jsonRecordArray, parseJsonValue } from "../json.js";

export type DraftMessage = {
  text: string;
  textEn?: string;
  media: Record<string, unknown>[];
  entities: unknown[];
};

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

export function parseTargets(value: unknown): Record<string, boolean> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_TARGETS };
  return {
    ...DEFAULT_TARGETS,
    ...Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, enabled]) => [key, Boolean(enabled)])),
  };
}

export function parseJson(value: unknown): unknown {
  return parseJsonValue(value);
}

export function parseArrayValue(value: unknown): Record<string, unknown>[] {
  return jsonRecordArray(value);
}

export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || "Alex Getman update";
}

export function slugify(text: string, postId: number): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `post-${postId}`;
}
