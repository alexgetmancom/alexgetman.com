import type { BackendConfig } from "../config.js";
import { HttpPublishError, type PublishResult } from "../publishing/errors.js";
import { payloadCanonicalUrl, payloadMedia } from "./payload.js";

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
  const canonicalUrl = payloadCanonicalUrl(payload, config);
  const tags = Array.isArray(payload.tags) ? payload.tags.map((tag) => String(tag)) : [];
  const mainImage = stringValue(payload.mainImage) || stringValue(payload.main_image) || null;
  const inlineImage = mainImage ?? payloadMedia(payload).find((item) => item.type === "IMAGE" && item.vpsUrl)?.vpsUrl ?? null;
  return {
    title,
    bodyMarkdown:
      inlineImage && !bodyMarkdown.includes(`](${inlineImage})`) ? `![${title}](${inlineImage})\n\n${bodyMarkdown}` : bodyMarkdown,
    canonicalUrl,
    tags,
    // Dev.to needs this field for the card cover; the same image is also put
    // into Markdown so the article body remains complete outside the card view.
    mainImage: inlineImage,
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

export async function updateDevtoArticle(
  articleId: number,
  patch: Partial<DevtoArticleInput>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!config.DEVTO_API_KEY) return false;
  const article: Record<string, unknown> = {};
  if (patch.title) article.title = patch.title;
  if (patch.bodyMarkdown) article.body_markdown = patch.bodyMarkdown;
  if (patch.canonicalUrl) article.canonical_url = patch.canonicalUrl;
  if (patch.mainImage) article.main_image = patch.mainImage;
  if (patch.tags) article.tags = cleanTags(patch.tags);
  if (patch.published != null) article.published = patch.published;
  const response = await fetchImpl(`https://dev.to/api/articles/${articleId}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; alexgetman-backend/1.0; +https://alexgetman.com)",
      "api-key": config.DEVTO_API_KEY,
    },
    body: JSON.stringify({ article }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new HttpPublishError(`dev.to update failed: ${response.status} ${body}`, response.status, body);
  }
  return true;
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
