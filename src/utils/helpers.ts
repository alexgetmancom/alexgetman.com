// Shared helper functions for alexgetman.com Astro website
import sanitizeHtmlLibrary from 'sanitize-html';

export function cleanText(text: string): string {
  return (text || "").replace(/\n{3,}/g, "\n\n").trim();
}

export function compactText(text: string): string {
  return cleanText(text).replace(/\s+/g, " ").trim();
}

export function truncateText(value: string, limit: number): string {
  const text = compactText(value);
  if (text.length <= limit) {
    return text;
  }
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}

export function excerptAfterTitle(text: string, title: string, limit: number): string {
  const source = compactText(text);
  const cleanTitle = compactText(title);
  let excerpt = source;
  if (cleanTitle && source.toLowerCase().startsWith(cleanTitle.toLowerCase())) {
    excerpt = source.slice(cleanTitle.length).replace(/^[\s:—–-]+/, "").trim();
  }
  if (!excerpt || excerpt.length < 24) {
    excerpt = source;
  }
  return truncateText(excerpt, limit);
}

export function removeLeadingEmoji(text: string): string {
  if (!text) return "";
  let cleaned = text.trim();
  
  // 1. Regional indicators (flags)
  const flagMatch = cleaned.match(/^(\p{RI}{2})\s*/u);
  if (flagMatch) {
    return cleaned.slice(flagMatch[1].length).trim();
  }
  
  // 2. Emojis with ZWJ and variant selectors
  const baseEmojiPart = `(?:[^\\s\\w\\d.,!?;:()""''«»а-яА-ЯёЁa-zA-Z][\\ufe00-\\ufe0f\\u20e3]?|[\\ud83c][\\udffb-\\udfff]?)`;
  const zwjRegex = new RegExp(`^(?:${baseEmojiPart}(?:\\u200d${baseEmojiPart})*)`, 'u');
  
  const match = cleaned.match(zwjRegex);
  if (match && match[0]) {
    const symbol = match[0];
    if (/\p{Emoji}/u.test(symbol) && !/^[#*0-9]$/.test(symbol[0])) {
      return cleaned.slice(symbol.length).trim();
    }
  }
  return cleaned;
}

export function getFirstSentence(text: string): string {
  if (!text) return "";
  const newlineIdx = text.indexOf('\n');
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

export function formatDate(value: string): string {
  if (!value) return "";
  try {
    const date = new Date(value);
    const formatter = new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Moscow",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatter.format(date).replace(",", "");
  } catch (e) {
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
  } catch (e) {
    return value;
  }
}

export function formatRelativeTime(value: string, locale = 'en'): string {
  try {
    const date = new Date(value);
    const diffMs = Date.now() - date.getTime();
    const absMs = Math.abs(diffMs);
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const rtf = new Intl.RelativeTimeFormat(locale === 'ru' ? 'ru' : 'en', { numeric: 'auto' });
    if (absMs < hour) return rtf.format(Math.round(-diffMs / minute), 'minute');
    if (absMs < day) return rtf.format(Math.round(-diffMs / hour), 'hour');
    return rtf.format(Math.round(-diffMs / day), 'day');
  } catch (e) {
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
  } catch (e) {
    return "";
  }
}

export function getSmartBadge(text: string): { label: string; class: string; emoji: string } {
  const t = (text || "").toLowerCase();
  if (t.includes("слив") || t.includes("утек") || t.includes("секрет") || t.includes("leak") || t.includes("эксклюзив")) {
    return { label: "Сливы", class: "badge--leaks", emoji: "⚡" };
  }
  if (t.includes("gpt") || t.includes("gemini") || t.includes("claude") || t.includes("anthropic") || t.includes("openai") || t.includes("google") || t.includes("llama") || t.includes("codex")) {
    return { label: "ИИ-Модели", class: "badge--ai", emoji: "🤖" };
  }
  if (t.includes("нейросеть") || t.includes("midjourney") || t.includes("sora") || t.includes("генераци") || t.includes("искусствен") || t.includes("ии-") || t.includes("ai ")) {
    return { label: "Нейросети", class: "badge--neural", emoji: "🎨" };
  }
  return { label: "Новости", class: "badge--news", emoji: "📰" };
}

export function categorySlugFromBadge(badge: { class?: string; label?: string } | string): string {
  const value = typeof badge === 'string' ? badge : (badge.class || badge.label || '');
  if (value.includes('leak') || value === 'Сливы') return 'leaks';
  if (value.includes('ai') || value === 'ИИ-Модели') return 'ai-models';
  if (value.includes('neural') || value === 'Нейросети') return 'neural-networks';
  return 'news';
}

export function categoryLabel(slug: string, locale = 'en'): string {
  const labels: Record<string, { en: string; ru: string }> = {
    'leaks': { en: 'Leaks', ru: 'Сливы' },
    'ai-models': { en: 'AI Models', ru: 'ИИ-Модели' },
    'neural-networks': { en: 'Neural Networks', ru: 'Нейросети' },
    'news': { en: 'News', ru: 'Новости' },
  };
  return labels[slug]?.[locale === 'ru' ? 'ru' : 'en'] || labels.news[locale === 'ru' ? 'ru' : 'en'];
}

export function estimateReadTime(text: string, locale = 'en'): string {
  const clean = compactText(String(text || '').replace(/<[^>]+>/g, ' '));
  const words = clean ? clean.split(/\s+/).length : 0;
  const minutes = Math.max(1, Math.ceil(words / 220));
  return locale === 'ru' ? `${minutes} мин чтения` : `${minutes} min read`;
}

export function getPostPath(item: any, locale = 'en'): string {
  if (!item) return "/";
  if (typeof item === 'object') {
    const postId = item.post_id;
    if (!postId) return "/";
    if (locale === 'ru') {
      return `/ru/${postId}/${item.slug_ru || `post-${postId}`}/`;
    }
    return `/${postId}/${item.slug_en || `post-${postId}`}/`;
  }
  return `/${item}/post-${item}/`;
}

export function formatViewsCount(views: number): string {
  if (!views) return "0";
  if (views >= 1000000) {
    return (views / 1000000).toFixed(1).replace('.0', '') + 'M';
  }
  if (views >= 1000) {
    return (views / 1000).toFixed(1).replace('.0', '') + 'K';
  }
  return views.toString();
}

export function sanitizeHtml(htmlStr: string): string {
  if (!htmlStr) return '';
  return sanitizeHtmlLibrary(htmlStr, {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'i', 'li',
      'ol', 'p', 'pre', 's', 'span', 'strong', 'u', 'ul'
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      code: ['class'],
      pre: ['class'],
      span: ['class'],
      div: ['class'],
      p: ['class']
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tg'],
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto', 'tg']
    },
    transformTags: {
      a: sanitizeHtmlLibrary.simpleTransform('a', {
        rel: 'noopener noreferrer'
      }, true)
    }
  });
}
