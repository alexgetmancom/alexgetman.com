import rss from '@astrojs/rss';
import fs from 'node:fs';
import path from 'node:path';

export async function GET(context) {
  const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
  const prodFeedJsonPath = path.join(dataDir, 'feed.json');
  const localFeedJsonPath = path.resolve('apps/web/src/data/feed.json');

  let parsedData = null;

  if (fs.existsSync(prodFeedJsonPath)) {
    try {
      parsedData = JSON.parse(fs.readFileSync(prodFeedJsonPath, 'utf-8'));
    } catch (e) {
      console.error(e);
    }
  }

  if (!parsedData && fs.existsSync(localFeedJsonPath)) {
    try {
      parsedData = JSON.parse(fs.readFileSync(localFeedJsonPath, 'utf-8'));
    } catch (e) {
      console.error(e);
    }
  }

  let feedItems = [];
  if (parsedData) {
    if (Array.isArray(parsedData)) {
      feedItems = parsedData;
    } else if (parsedData.items && Array.isArray(parsedData.items)) {
      feedItems = parsedData.items;
    }
  }

  // Sort by date descending and limit to top 50 items to keep feed size manageable
  const sortedItems = feedItems
    .filter(item => item.has_ru && item.post_id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  // Title truncation helper
  function cleanText(text) {
    return (text || "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function compactText(text) {
    return cleanText(text).replace(/\s+/g, " ").trim();
  }
  function truncateText(value, limit) {
    const text = compactText(value);
    if (text.length <= limit) {
      return text;
    }
    return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
  }

  return rss({
    title: 'RU — Алексей Гетманец | alexgetmancom',
    description: 'Новости ИИ, автоматизация, разработка и self-hosted системы от Алексея Гетманца.',
    site: context.site || 'https://alexgetman.com',
    items: sortedItems.map((item) => {
      const id = item.post_id;
      const title = truncateText(item.text || "", 86) || `Пост ${id}`;
      return {
        title: title,
        pubDate: new Date(item.date),
        description: item.html || item.text,
        link: `/ru/${id}/${item.slug_ru}/`
      };
    }),
    customData: `<language>ru</language>`,
  });
}
