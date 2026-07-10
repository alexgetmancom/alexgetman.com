import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";

export type MediaKind = "IMAGE" | "VIDEO";

export type PublishMediaItem = {
  type: MediaKind;
  localPath?: string;
  fileId?: string;
  token?: string;
  vpsUrl?: string;
  storyLocalPath?: string;
  storyVpsUrl?: string;
  [key: string]: unknown;
};

export function payloadText(payload: Record<string, unknown>): string {
  return stringValue(payload.text_en) || stringValue(payload.text) || stringValue(payload.bodyMarkdown) || stringValue(payload.body_markdown) || "";
}

export function payloadTitle(payload: Record<string, unknown>): string {
  return stringValue(payload.title) || firstLine(payloadText(payload)) || "Alex Getman update";
}

export function payloadCanonicalUrl(payload: Record<string, unknown>, config: BackendConfig): string | null {
  const direct = stringValue(payload.canonicalUrl) || stringValue(payload.canonical_url) || stringValue(payload.url);
  if (direct) return direct;
  const postId = payload.post_id ?? payload.postId;
  const slug = payload.slug_en ?? payload.slugEn ?? payload.slug;
  if (postId == null || !slug) return null;
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/${postId}/${String(slug).replace(/^\/+/, "")}/`;
}

export function payloadMedia(payload: Record<string, unknown>): PublishMediaItem[] {
  const raw = payload.media_en ?? payload.media ?? payload.mediaItems ?? payload.media_items;
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return values.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    const type = normalizeMediaType(record.type);
    if (!type) return [];
    const localPath = stringValue(record.localPath) || stringValue(record.local_path) || stringValue(record.path);
    const fileId = stringValue(record.fileId) || stringValue(record.file_id);
    const vpsUrl = stringValue(record.vpsUrl) || stringValue(record.vps_url) || stringValue(record.public_url) || stringValue(record.url);
    if (!localPath && !fileId && !vpsUrl) return [];
    const item: PublishMediaItem = { ...record, type };
    if (localPath) item.localPath = localPath;
    if (fileId) item.fileId = fileId;
    const token = stringValue(record.token);
    if (token) item.token = token;
    if (vpsUrl) item.vpsUrl = vpsUrl;
    const storyLocalPath = stringValue(record.storyLocalPath) || stringValue(record.story_local_path);
    if (storyLocalPath) item.storyLocalPath = storyLocalPath;
    const storyVpsUrl = stringValue(record.storyVpsUrl) || stringValue(record.story_vps_url);
    if (storyVpsUrl) item.storyVpsUrl = storyVpsUrl;
    return [item];
  });
}

export function splitText(text: string, limit: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [""];
  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const take = breakAt > Math.floor(limit * 0.5) ? breakAt + (window[breakAt] === "." ? 1 : 0) : limit;
    parts.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.length > 0 ? parts : [normalized];
}

export function stripLeadingEmojis(text: string): string {
  return text.replace(/^[\s\p{Emoji_Presentation}\p{Extended_Pictographic}]+/u, "").trimStart();
}

export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>)]*/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

export async function readFileBlob(filePath: string, contentType = guessContentType(filePath)): Promise<Blob> {
  const bytes = await fs.promises.readFile(filePath);
  return new Blob([bytes], { type: contentType });
}

export function fileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}

export function safeMediaName(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "media";
}

export function mediaExtension(item: PublishMediaItem): string {
  if (item.localPath) {
    const ext = path.extname(item.localPath);
    if (ext) return ext;
  }
  return item.type === "VIDEO" ? ".mp4" : ".jpg";
}

export function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  return "image/jpeg";
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function normalizeMediaType(value: unknown): MediaKind | null {
  const text = String(value ?? "").toLowerCase();
  if (text === "image" || text === "photo") return "IMAGE";
  if (text === "video") return "VIDEO";
  return null;
}
