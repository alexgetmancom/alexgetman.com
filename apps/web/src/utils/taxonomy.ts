export type SmartBadge = { label: string; class: string; emoji: string };

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

const labels: Record<string, { en: string; ru: string }> = {
  leaks: { en: "Leaks", ru: "Сливы" },
  "ai-models": { en: "AI Models", ru: "ИИ-Модели" },
  "neural-networks": { en: "Neural Networks", ru: "Нейросети" },
  news: { en: "News", ru: "Новости" },
};

export function categoryLabel(slug: string, locale = "en"): string {
  return labels[slug]?.[locale === "ru" ? "ru" : "en"] || labels.news[locale === "ru" ? "ru" : "en"];
}
