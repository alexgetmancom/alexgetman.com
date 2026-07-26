import * as z from "zod";

type MediaKind = "IMAGE" | "VIDEO";

export type PublishMediaItem = {
  type: MediaKind;
  localPath?: string;
  fileId?: string;
  token?: string;
  vpsUrl?: string;
  storyLocalPath?: string;
  telegramStoryLocalPath?: string;
  storyVpsUrl?: string;
  [key: string]: unknown;
};

const mediaRecordSchema = z
  .object({
    type: z.unknown().optional(),
    localPath: z.string().optional(),
    local_path: z.string().optional(),
    path: z.string().optional(),
    fileId: z.string().optional(),
    file_id: z.string().optional(),
    token: z.string().optional(),
    vpsUrl: z.string().optional(),
    vps_url: z.string().optional(),
    public_url: z.string().optional(),
    url: z.string().optional(),
    storyLocalPath: z.string().optional(),
    story_local_path: z.string().optional(),
    telegramStoryLocalPath: z.string().optional(),
    telegram_story_local_path: z.string().optional(),
    storyVpsUrl: z.string().optional(),
    story_vps_url: z.string().optional(),
  })
  .passthrough();

const publishPayloadSchema = z
  .object({
    text: z.string().optional(),
    text_ru: z.string().optional(),
    text_en: z.string().optional(),
    title: z.string().optional(),
    locale: z.string().optional(),
    post_id: z.union([z.string(), z.number()]).optional(),
    postId: z.union([z.string(), z.number()]).optional(),
    slug: z.string().optional(),
    slug_ru: z.string().optional(),
    slug_en: z.string().optional(),
    slugEn: z.string().optional(),
    canonicalUrl: z.string().optional(),
    canonical_url: z.string().optional(),
    bodyMarkdown: z.string().optional(),
    body_markdown: z.string().optional(),
    mainImage: z.string().optional(),
    main_image: z.string().optional(),
    url: z.string().optional(),
    media: z.unknown().optional(),
    media_en: z.unknown().optional(),
    mediaItems: z.unknown().optional(),
    media_items: z.unknown().optional(),
  })
  .passthrough();

function parsePublishPayload(value: unknown): Record<string, unknown> {
  const parsed = publishPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function payloadText(payload: Record<string, unknown>): string {
  const parsed = parsePublishPayload(payload);
  if (stringValue(parsed.locale).toLowerCase() === "ru") {
    return stringValue(parsed.text_ru) || stringValue(parsed.text) || stringValue(parsed.text_en) || "";
  }
  return stringValue(parsed.text_en) || stringValue(parsed.text) || "";
}

export function payloadMedia(payload: Record<string, unknown>): PublishMediaItem[] {
  payload = parsePublishPayload(payload);
  const raw =
    stringValue(payload.locale).toLowerCase() === "ru"
      ? (payload.media ?? payload.media_en ?? payload.mediaItems ?? payload.media_items)
      : (payload.media_en ?? payload.media ?? payload.mediaItems ?? payload.media_items);
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return values.flatMap((value) => {
    const parsed = mediaRecordSchema.safeParse(value);
    if (!parsed.success) return [];
    const record = parsed.data;
    const type = normalizeMediaType(record.type);
    if (!type) return [];
    const localPath = stringValue(record.localPath) || stringValue(record.local_path) || stringValue(record.path);
    const fileId = stringValue(record.fileId) || stringValue(record.file_id);
    const vpsUrl = stringValue(record.vpsUrl) || stringValue(record.vps_url) || stringValue(record.public_url) || stringValue(record.url);
    if (!localPath && !fileId && !vpsUrl) return [];
    const item: PublishMediaItem = { type };
    if (localPath) item.localPath = localPath;
    if (fileId) item.fileId = fileId;
    const token = stringValue(record.token);
    if (token) item.token = token;
    if (vpsUrl) item.vpsUrl = vpsUrl;
    const storyLocalPath = stringValue(record.storyLocalPath) || stringValue(record.story_local_path);
    if (storyLocalPath) item.storyLocalPath = storyLocalPath;
    const telegramStoryLocalPath = stringValue(record.telegramStoryLocalPath) || stringValue(record.telegram_story_local_path);
    if (telegramStoryLocalPath) item.telegramStoryLocalPath = telegramStoryLocalPath;
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

export function mediaExtension(item: PublishMediaItem): string {
  if (item.localPath) {
    const ext = fileExtension(item.localPath);
    if (ext) return ext;
  }
  return item.type === "VIDEO" ? ".mp4" : ".jpg";
}

export function guessContentType(filePath: string): string {
  const ext = fileExtension(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  return "image/jpeg";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMediaType(value: unknown): MediaKind | null {
  const text = String(value ?? "").toLowerCase();
  if (text === "image" || text === "photo") return "IMAGE";
  if (text === "video") return "VIDEO";
  return null;
}

function fileExtension(filePath: string): string {
  const name = filePath.slice(Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}
