import { DEFAULT_SITE_LOCALE, type SiteLocale } from "./locale";

type SmartBadge = { label: string; class: string; emoji: string };

export function getSmartBadge(text: string): SmartBadge {
  const value = (text || "").toLowerCase();
  if (["слив", "утек", "секрет", "leak", "эксклюзив"].some((word) => value.includes(word)))
    return { label: "Сливы", class: "badge--leaks", emoji: "⚡" };
  if (["gpt", "gemini", "claude", "anthropic", "openai", "google", "llama", "codex"].some((word) => value.includes(word)))
    return { label: "ИИ-Модели", class: "badge--ai", emoji: "🤖" };
  if (["нейросеть", "midjourney", "sora", "генераци", "искусствен", "ии-", "ai "].some((word) => value.includes(word)))
    return { label: "Нейросети", class: "badge--neural", emoji: "🎨" };
  return { label: "Новости", class: "badge--news", emoji: "📰" };
}

/** Exact lookup rather than substring matching: `value.includes("ai")` sent any
 * future class or label that merely contained those letters ("badge--airdrop")
 * into ai-models. A badge is a closed set, so treat it as one. */
const SLUG_BY_BADGE: Record<string, string> = {
  "badge--leaks": "leaks",
  "badge--ai": "ai-models",
  "badge--neural": "neural-networks",
  "badge--news": "news",
  Сливы: "leaks",
  "ИИ-Модели": "ai-models",
  Нейросети: "neural-networks",
  Новости: "news",
};

export function categorySlugFromBadge(badge: { class?: string; label?: string } | string): string {
  const value = typeof badge === "string" ? badge : badge.class || badge.label || "";
  return SLUG_BY_BADGE[value.trim()] ?? "news";
}

const labels: Record<string, Record<SiteLocale, string>> = {
  leaks: { en: "Leaks", ru: "Сливы" },
  "ai-models": { en: "AI Models", ru: "ИИ-Модели" },
  "neural-networks": { en: "Neural Networks", ru: "Нейросети" },
  news: { en: "News", ru: "Новости" },
};

export function categoryLabel(slug: string, locale: SiteLocale = DEFAULT_SITE_LOCALE): string {
  return (labels[slug] ?? labels.news)[locale];
}

/** The category of a text, named in the reader's language. */
export function localizedCategory(text: string, locale: SiteLocale): string {
  return categoryLabel(categorySlugFromBadge(getSmartBadge(text)), locale);
}
