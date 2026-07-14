import { jsonRecordArray } from "../json.js";

/** Transport-neutral content captured from any interface before it becomes a draft. */
export type DraftMessage = {
  text: string;
  textEn?: string;
  media: Record<string, unknown>[];
  entities: unknown[];
};

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
