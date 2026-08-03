import type { FeedItem } from "../../../backend/src/public/site-read-model.js";

export type SiteLocale = "en" | "ru";

export function hasPublishedLocale(item: FeedItem, locale: SiteLocale): boolean {
  const enabled = locale === "ru" ? item.has_ru : item.has_en;
  const text = locale === "ru" ? item.text : item.text_en;
  const slug = locale === "ru" ? item.slug_ru : item.slug_en;
  return Boolean(enabled && text && item.post_id && slug);
}

export function localizedText(item: FeedItem, locale: SiteLocale): string {
  return locale === "ru" ? item.text : item.text_en || item.text;
}

export function localizedHtml(item: FeedItem, locale: SiteLocale): string {
  return locale === "ru" ? item.html || item.text : item.html_en || item.text_en || item.text;
}

export function localizedSlug(item: FeedItem, locale: SiteLocale): string | null {
  return locale === "ru" ? item.slug_ru : item.slug_en;
}

export function sortedPublishedItems(items: readonly FeedItem[], locale: SiteLocale, limit?: number): FeedItem[] {
  const sorted = items
    .filter((item) => hasPublishedLocale(item, locale))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return limit == null ? sorted : sorted.slice(0, limit);
}
