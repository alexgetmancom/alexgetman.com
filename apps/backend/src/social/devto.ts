import type { BackendConfig } from "../config.js";
import { HttpPublishError, type PublishResult } from "../queue/errors.js";

type DevtoArticleInput = {
  title: string;
  bodyMarkdown: string;
  canonicalUrl?: string | null;
  tags?: string[] | null;
  mainImage?: string | null;
  published?: boolean;
};

export function devtoArticleFromPayload(payload: Record<string, unknown>, config: BackendConfig): DevtoArticleInput {
  const title =
    stringValue(payload.title) ||
    firstLine(stringValue(payload.text_en) || stringValue(payload.text) || stringValue(payload.bodyMarkdown)) ||
    "Alex Getman update";
  const bodyMarkdown =
    stringValue(payload.bodyMarkdown) ||
    stringValue(payload.body_markdown) ||
    stringValue(payload.text_en) ||
    stringValue(payload.text) ||
    "";
  const canonicalUrl = stringValue(payload.canonicalUrl) || stringValue(payload.canonical_url) || canonicalFromPayload(payload, config);
  const tags = Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag)) : [];
  const mainImage = stringValue(payload.mainImage) || stringValue(payload.main_image) || null;
  return {
    title,
    bodyMarkdown,
    canonicalUrl,
    tags,
    mainImage,
    published: payload.published == null ? true : Boolean(payload.published),
  };
}

export async function publishToDevto(
  input: DevtoArticleInput,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.DEVTO_API_KEY) {
    return { skipped: true, reason: "missing DEVTO_API_KEY" };
  }
  const article: Record<string, unknown> = {
    title: input.title,
    body_markdown: input.bodyMarkdown,
    published: input.published ?? true,
  };
  if (input.canonicalUrl) article.canonical_url = input.canonicalUrl;
  if (input.mainImage) article.main_image = input.mainImage;
  const tags = cleanTags(input.tags ?? []);
  if (tags.length > 0) article.tags = tags;

  const response = await fetchImpl("https://dev.to/api/articles", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; alexgetman-backend/1.0; +https://alexgetman.com)",
      "api-key": config.DEVTO_API_KEY,
    },
    body: JSON.stringify({ article }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new HttpPublishError(`dev.to publish failed: ${response.status} ${body}`, response.status, body);
  }
  const data = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  const url = typeof data.url === "string" ? data.url : null;
  return { ok: true, id: typeof data.id === "number" || typeof data.id === "string" ? data.id : url, url, raw: data };
}

function cleanTags(tags: string[]): string[] {
  return tags
    .map((tag) => tag.toLowerCase().replaceAll(" ", "").replaceAll("-", "").slice(0, 20))
    .filter(Boolean)
    .slice(0, 4);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function canonicalFromPayload(payload: Record<string, unknown>, config: BackendConfig): string | null {
  const postId = payload.post_id ?? payload.postId;
  const slug = payload.slug_en ?? payload.slugEn;
  if (postId == null || !slug) return null;
  return `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/${postId}/${String(slug).replace(/^\/+/, "")}/`;
}
