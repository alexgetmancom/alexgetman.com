// Shared presentation helpers for Astro pages.

import type { FeedItem, SiteMedia } from "./feed";

export type FeedLocale = "en" | "ru";

export function siteUrlFromContext(context: { site?: URL | string | null }): string {
  return context.site ? context.site.toString().replace(/\/$/, "") : "https://alexgetman.com";
}

export function cleanText(text: string): string {
  return (text || "").replace(/\n{3,}/g, "\n\n").trim();
}

export function compactText(text: string): string {
  return cleanText(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateText(value: string, limit: number): string {
  const text = compactText(value);
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function excerptAfterTitle(text: string, title: string, limit: number): string {
  const source = compactText(text);
  const cleanTitle = compactText(title);
  let excerpt = source;
  if (cleanTitle && source.toLowerCase().startsWith(cleanTitle.toLowerCase())) {
    excerpt = source
      .slice(cleanTitle.length)
      .replace(/^[\s:—–-]+/, "")
      .trim();
    if (!excerpt || excerpt.length < 24) {
      return "";
    }
  }
  if (!excerpt) {
    excerpt = source;
  }
  return truncateText(excerpt, limit);
}

export function removeLeadingEmoji(text: string): string {
  if (!text) return "";
  const cleaned = text.trim();

  // 1. Regional indicators (flags)
  const flagMatch = cleaned.match(/^(\p{RI}{2})\s*/u);
  if (flagMatch) {
    return cleaned.slice(flagMatch[1].length).trim();
  }

  // 2. Emojis with ZWJ and variant selectors
  const baseEmojiPart = `(?:[^\\s\\w\\d.,!?;:()""''«»а-яА-ЯёЁa-zA-Z][\\ufe00-\\ufe0f\\u20e3]?|[\\ud83c][\\udffb-\\udfff]?)`;
  const zwjRegex = new RegExp(`^(?:${baseEmojiPart}(?:\\u200d${baseEmojiPart})*)`, "u");

  const match = cleaned.match(zwjRegex);
  if (match?.[0]) {
    const symbol = match[0];
    if (/\p{Emoji}/u.test(symbol) && !/^[#*0-9]$/.test(symbol[0])) {
      return cleaned.slice(symbol.length).trim();
    }
  }
  return cleaned;
}

export function getFirstSentence(text: string): string {
  if (!text) return "";
  const newlineIdx = text.indexOf("\n");
  const match = text.match(/^.*?[.!?](?:\s|\n|$)/s);
  if (match) {
    const sentence = match[0].trim();
    if (newlineIdx !== -1 && newlineIdx < match[0].length) {
      return text.slice(0, newlineIdx).trim();
    }
    return sentence;
  }
  if (newlineIdx !== -1) {
    return text.slice(0, newlineIdx).trim();
  }
  return text.trim();
}

export function formatDate(value: string, locale = "en-GB"): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: locale === "ru-RU" ? "2-digit" : "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatter.format(date).replace(",", "");
  } catch (_e) {
    return value;
  }
}

export function formatDateRussian(value: string): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    // Format: "25 мая 00:13" or "25 мая, 00:13"
    return formatter.format(date).replace(" в ", ", ");
  } catch (_e) {
    return value;
  }
}

export function formatRelativeTime(value: string, locale = "en"): string {
  try {
    const date = new Date(value);
    const diffMs = Date.now() - date.getTime();
    const absMs = Math.abs(diffMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const rtf = new Intl.RelativeTimeFormat(locale === "ru" ? "ru" : "en", { numeric: "auto" });
    if (absMs < hour) return rtf.format(Math.round(-diffMs / minute), "minute");
    if (absMs < day) return rtf.format(Math.round(-diffMs / hour), "hour");
    return rtf.format(Math.round(-diffMs / day), "day");
  } catch (_e) {
    return "";
  }
}

export function formatTimeOnly(value: string): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatter.format(date);
  } catch (_e) {
    return "";
  }
}

export function getSmartBadge(text: string): { label: string; class: string; emoji: string } {
  const t = (text || "").toLowerCase();
  if (t.includes("слив") || t.includes("утек") || t.includes("секрет") || t.includes("leak") || t.includes("эксклюзив")) {
    return { label: "Сливы", class: "badge--leaks", emoji: "⚡" };
  }
  if (
    t.includes("gpt") ||
    t.includes("gemini") ||
    t.includes("claude") ||
    t.includes("anthropic") ||
    t.includes("openai") ||
    t.includes("google") ||
    t.includes("llama") ||
    t.includes("codex")
  ) {
    return { label: "ИИ-Модели", class: "badge--ai", emoji: "🤖" };
  }
  if (
    t.includes("нейросеть") ||
    t.includes("midjourney") ||
    t.includes("sora") ||
    t.includes("генераци") ||
    t.includes("искусствен") ||
    t.includes("ии-") ||
    t.includes("ai ")
  ) {
    return { label: "Нейросети", class: "badge--neural", emoji: "🎨" };
  }
  return { label: "Новости", class: "badge--news", emoji: "📰" };
}

export function getSmartCategory(text: string): string {
  return getSmartBadge(text).label;
}

export function categorySlugFromBadge(badge: { class?: string; label?: string } | string): string {
  const value = typeof badge === "string" ? badge : badge.class || badge.label || "";
  if (value.includes("leak") || value === "Сливы") return "leaks";
  if (value.includes("ai") || value === "ИИ-Модели") return "ai-models";
  if (value.includes("neural") || value === "Нейросети") return "neural-networks";
  return "news";
}

export function categoryLabel(slug: string, locale = "en"): string {
  const labels: Record<string, { en: string; ru: string }> = {
    leaks: { en: "Leaks", ru: "Сливы" },
    "ai-models": { en: "AI Models", ru: "ИИ-Модели" },
    "neural-networks": { en: "Neural Networks", ru: "Нейросети" },
    news: { en: "News", ru: "Новости" },
  };
  return labels[slug]?.[locale === "ru" ? "ru" : "en"] || labels.news[locale === "ru" ? "ru" : "en"];
}

export function estimateReadTime(text: string, locale = "en"): string {
  const clean = compactText(String(text || "").replace(/<[^>]+>/g, " "));
  const words = clean ? clean.split(/\s+/).length : 0;
  const minutes = Math.max(1, Math.ceil(words / 220));
  return locale === "ru" ? `${minutes} мин чтения` : `${minutes} min read`;
}

export function getPostPath(item: FeedItem | number | string | null | undefined, locale: FeedLocale = "en"): string {
  if (!item) return "/";
  if (typeof item === "object") {
    const postId = item.post_id;
    if (!postId) return "/";
    if (locale === "ru") {
      return `/ru/${postId}/${item.slug_ru || `post-${postId}`}/`;
    }
    return `/${postId}/${item.slug_en || `post-${postId}`}/`;
  }
  return `/${item}/post-${item}/`;
}

export function normalizePublicPath(value: string | null | undefined): string {
  return String(value || "").replace(/^\/+/, "");
}

export function postImagePath(item: FeedItem, locale: FeedLocale = "en"): string | null {
  const localizedMedia = locale === "ru" ? item.media : item.media_en;
  const fallbackMedia = locale === "ru" ? item.media_en : item.media;
  const media =
    Array.isArray(localizedMedia) && localizedMedia.length > 0 ? localizedMedia : Array.isArray(fallbackMedia) ? fallbackMedia : [];
  const imageMedia = media.find((mediaItem: SiteMedia) => mediaItem.type !== "video" && mediaItem.path);
  const directImage = locale === "ru" ? item.image || item.image_en : item.image_en || item.image;
  return normalizePublicPath(directImage || imageMedia?.path) || null;
}

export function postVisualMedia(
  item: FeedItem,
  locale: FeedLocale = "en",
): { type: "image" | "video"; path: string; poster?: string } | null {
  const directImage = locale === "ru" ? item.image || item.image_en : item.image_en || item.image;
  const normalizedDirectImage = normalizePublicPath(directImage);
  if (normalizedDirectImage) {
    return { type: "image", path: normalizedDirectImage };
  }

  const localizedMedia = locale === "ru" ? item.media : item.media_en;
  const fallbackMedia = locale === "ru" ? item.media_en : item.media;
  const media =
    Array.isArray(localizedMedia) && localizedMedia.length > 0 ? localizedMedia : Array.isArray(fallbackMedia) ? fallbackMedia : [];
  const mediaItem = media.find((entry: SiteMedia) => entry.path);
  const path = normalizePublicPath(mediaItem?.path);
  if (!path) return null;
  const type = String(mediaItem?.type || "").toLowerCase() === "video" || /\.(mp4|webm|mov)$/i.test(path) ? "video" : "image";
  const poster = type === "video" ? normalizePublicPath(mediaItem?.poster) : "";
  return poster ? { type, path, poster } : { type, path };
}

export function postOgImagePath(item: FeedItem, locale: FeedLocale = "en"): string {
  const postId = item.post_id;
  if (!postId) return "/social-image.jpg";
  return `/og/posts/post-${postId}-${locale === "ru" ? "ru" : "en"}.jpg`;
}

export function responsiveImageSrcSet(publicPath: string | null | undefined): string | undefined {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized || !/\.(png|jpe?g)$/i.test(normalized)) return undefined;
  const base = normalized.replace(/[\\/]/g, "-").replace(/\.[a-z0-9]+$/i, "");
  return [360, 640, 960].map((width) => `/generated/responsive/${base}-${width}.webp ${width}w`).join(", ");
}

function hasBlockHtml(value: string): boolean {
  return /<(p|ul|ol|li|pre|blockquote|h2|h3|table|figure|div)\b/i.test(value);
}

function paragraphizeLines(lines: string[]): string {
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }

    const bulletItems: string[] = [];
    while (index < lines.length) {
      const match = lines[index].trim().match(/^(?:[-*•])\s+(.+)$/);
      if (!match) break;
      bulletItems.push(match[1]);
      index += 1;
    }
    if (bulletItems.length) {
      blocks.push(`<ul>${bulletItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      continue;
    }

    const numberedItems: string[] = [];
    while (index < lines.length) {
      const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
      if (!match) break;
      numberedItems.push(match[1]);
      index += 1;
    }
    if (numberedItems.length) {
      blocks.push(`<ol>${numberedItems.map((item) => `<li>${item}</li>`).join("")}</ol>`);
      continue;
    }

    blocks.push(`<p>${line}</p>`);
    index += 1;
  }
  return blocks.join("\n");
}

export function semanticPostHtml(value: string): string {
  const html = String(value || "").trim();
  if (!html) return "";
  if (hasBlockHtml(html)) return html;
  const normalized = html
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const chunks = normalized
    .split(/\n{2,}/)
    .map((chunk) => paragraphizeLines(chunk.split("\n")))
    .filter(Boolean);
  return chunks.join("\n");
}

export function formatViewsCount(views: number): string {
  if (!views) return "0";
  if (views >= 1000000) {
    return `${(views / 1000000).toFixed(1).replace(".0", "")}M`;
  }
  if (views >= 1000) {
    return `${(views / 1000).toFixed(1).replace(".0", "")}K`;
  }
  return views.toString();
}

export function sanitizeHtml(htmlStr: string): string {
  if (!htmlStr) return "";
  const tags = new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "u",
    "ul",
  ]);
  const classTags = new Set(["code", "pre", "span", "div", "p"]);
  return htmlStr.replace(/<\/?[A-Za-z][^>]*>/g, (tag) => {
    const closing = /^<\//.test(tag);
    const name = tag.match(/^<\/?\s*([A-Za-z0-9]+)/)?.[1]?.toLowerCase();
    if (!name || !tags.has(name)) return "";
    if (closing) return `</${name}>`;
    if (name === "br") return "<br>";
    const attributes: string[] = [];
    if (name === "a") {
      const href = tag.match(/\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      if (href && /^(https?:|mailto:|tg:)/i.test(href)) attributes.push(`href="${escapeHtmlAttribute(href)}"`);
      const target = tag.match(/\btarget\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      if (target === "_blank") attributes.push('target="_blank"');
      attributes.push('rel="noopener noreferrer"');
    } else if (classTags.has(name)) {
      const className = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1];
      if (className) attributes.push(`class="${escapeHtmlAttribute(className.replace(/[^A-Za-z0-9 _-]/g, ""))}"`);
    }
    return `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  });
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}
