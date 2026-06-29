import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
const prodFeedJsonPath = path.join(dataDir, 'feed.json');
const localFeedJsonPath = path.resolve('src/data/feed.json');

function compactText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, limit) {
  const text = compactText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function excerptAfterTitle(text, title, limit) {
  const source = compactText(text);
  const cleanTitle = compactText(title);
  let excerpt = source;
  if (cleanTitle && source.toLowerCase().startsWith(cleanTitle.toLowerCase())) {
    excerpt = source.slice(cleanTitle.length).replace(/^[\s:—–-]+/, '').trim();
  }
  if (!excerpt || excerpt.length < 24) {
    excerpt = source;
  }
  return truncateText(excerpt, limit);
}

function getFirstSentence(text) {
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
  if (newlineIdx !== -1) {
    return value.slice(0, newlineIdx).trim();
  }
  return value;
}

function getSmartBadge(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('слив') || t.includes('утек') || t.includes('секрет') || t.includes('leak') || t.includes('эксклюзив')) {
    return 'Сливы';
  }
  if (t.includes('gpt') || t.includes('gemini') || t.includes('claude') || t.includes('anthropic') || t.includes('openai') || t.includes('google') || t.includes('llama') || t.includes('codex')) {
    return 'ИИ-Модели';
  }
  if (t.includes('нейросеть') || t.includes('midjourney') || t.includes('sora') || t.includes('генераци') || t.includes('искусствен') || t.includes('ии-') || t.includes('ai ')) {
    return 'Нейросети';
  }
  return 'Новости';
}

function loadFeedItems() {
  let parsedData = null;
  for (const filePath of [prodFeedJsonPath, localFeedJsonPath]) {
    if (!parsedData && fs.existsSync(filePath)) {
      try {
        parsedData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (e) {
        console.error(`Error reading ${filePath}:`, e);
      }
    }
  }

  if (Array.isArray(parsedData)) return parsedData;
  if (parsedData?.items && Array.isArray(parsedData.items)) return parsedData.items;
  return [];
}


function telegramToSearchItem(item) {
  const postId = item.post_id;
  const text = compactText(item.text || item.html || '');
  const title = compactText(item.title || getFirstSentence(item.text || text)) || `Публикация ${postId}`;
  return {
    id: `post:${postId}`,
    type: 'post',
    title: truncateText(title, 120),
    excerpt: excerptAfterTitle(text, title, 180),
    url: item.has_en
      ? `/${postId}/${item.slug_en}/`
      : `/ru/${postId}/${item.slug_ru}/`,
    date: item.date,
    source: 'alexgetman.com',
    category: getSmartBadge(item.text || text),
    image: item.image ? `/${item.image}` : null
  };
}


export async function GET() {
  const telegramItems = loadFeedItems()
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .map(telegramToSearchItem);

  return new Response(JSON.stringify({
    generatedAt: new Date().toISOString(),
    items: telegramItems
  }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
