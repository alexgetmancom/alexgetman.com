import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
const prodFeedJsonPath = path.join(dataDir, 'feed.json');
const localFeedJsonPath = path.resolve('apps/web/src/data/feed.json');

export function loadFeedItems() {
  let parsedData = null;

  for (const filePath of [prodFeedJsonPath, localFeedJsonPath]) {
    if (!parsedData && fs.existsSync(filePath)) {
      try {
        parsedData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
      }
    }
  }

  if (Array.isArray(parsedData)) return parsedData;
  if (parsedData?.items && Array.isArray(parsedData.items)) return parsedData.items;
  return [];
}

export function siteUrlFromContext(context) {
  return context.site ? context.site.toString().replace(/\/$/, '') : 'https://alexgetman.com';
}

export function cleanText(text) {
  return String(text || '').replace(/\n{3,}/g, '\n\n').trim();
}

export function compactText(value) {
  return cleanText(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function truncateText(value, limit) {
  const text = compactText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

export function excerptAfterTitle(text, title, limit) {
  const source = compactText(text);
  const cleanTitle = compactText(title);
  let excerpt = source;

  if (cleanTitle && source.toLowerCase().startsWith(cleanTitle.toLowerCase())) {
    excerpt = source.slice(cleanTitle.length).replace(/^[\s:—–-]+/, '').trim();
    if (!excerpt || excerpt.length < 24) return '';
  }

  return truncateText(excerpt || source, limit);
}

export function getFirstSentence(text) {
  const value = String(text || '').trim();
  if (!value) return '';

  const newlineIdx = value.indexOf('\n');
  const match = value.match(/^.*?[.!?](?:\s|\n|$)/s);
  if (match) {
    if (newlineIdx !== -1 && newlineIdx < match[0].length) {
      return value.slice(0, newlineIdx).trim();
    }
    return match[0].trim();
  }
  if (newlineIdx !== -1) return value.slice(0, newlineIdx).trim();
  return value;
}

export function formatDate(value, locale = 'en-GB') {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export function getSmartCategory(text) {
  const value = String(text || '').toLowerCase();
  if (value.includes('слив') || value.includes('утек') || value.includes('секрет') || value.includes('leak') || value.includes('эксклюзив')) {
    return 'Сливы';
  }
  if (value.includes('gpt') || value.includes('gemini') || value.includes('claude') || value.includes('anthropic') || value.includes('openai') || value.includes('google') || value.includes('llama') || value.includes('codex')) {
    return 'ИИ-Модели';
  }
  if (value.includes('нейросеть') || value.includes('midjourney') || value.includes('sora') || value.includes('генераци') || value.includes('искусствен') || value.includes('ии-') || value.includes('ai ')) {
    return 'Нейросети';
  }
  return 'Новости';
}

export function postImagePath(item, locale = 'en') {
  if (!item) return null;
  const localizedMedia = locale === 'ru' ? item.media : item.media_en;
  const fallbackMedia = locale === 'ru' ? item.media_en : item.media;
  const media = Array.isArray(localizedMedia) && localizedMedia.length > 0
    ? localizedMedia
    : (Array.isArray(fallbackMedia) ? fallbackMedia : []);
  const imageMedia = media.find((mediaItem) => mediaItem?.type !== 'video' && mediaItem?.path);
  const directImage = locale === 'ru'
    ? (item.image || item.image_en)
    : (item.image_en || item.image);
  const image = String(directImage || imageMedia?.path || '').replace(/^\/+/, '');
  return image ? `/${image}` : null;
}
