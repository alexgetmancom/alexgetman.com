import rss from '@astrojs/rss';
import fs from 'node:fs';
import path from 'node:path';

export async function GET(context) {
  const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
  const prodFeedJsonPath = path.join(dataDir, 'feed.json');
  const localFeedJsonPath = path.resolve('apps/web/src/data/feed.json');

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

  let feedItems = [];
  if (Array.isArray(parsedData)) {
    feedItems = parsedData;
  } else if (parsedData?.items && Array.isArray(parsedData.items)) {
    feedItems = parsedData.items;
  }

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

  const sortedItems = feedItems
    .filter(item => item.has_en && item.text_en && item.post_id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  return rss({
    title: 'Alex Getman | AI, automation and self-hosted systems',
    description: 'English updates from Alex Getman: AI news, automation, developer tools and self-hosted systems.',
    site: context.site || 'https://alexgetman.com',
    items: sortedItems.map((item) => {
      const id = item.post_id;
      const text = item.text_en || item.text || "";
      const title = truncateText(text, 86) || `Post ${id}`;
      return {
        title,
        pubDate: new Date(item.date),
        description: item.html_en || item.text_en,
        link: `/${id}/${item.slug_en}/`
      };
    }),
    customData: `<language>en</language>`,
  });
}
