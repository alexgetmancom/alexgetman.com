import fs from 'node:fs';
import path from 'node:path';

function loadFeedItems() {
  const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
  const prodFeedJsonPath = path.join(dataDir, 'feed.json');
  const localFeedJsonPath = path.resolve('src/data/feed.json');

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

  if (Array.isArray(parsedData)) {
    return parsedData;
  }
  if (parsedData?.items && Array.isArray(parsedData.items)) {
    return parsedData.items;
  }
  return [];
}

export async function GET() {
  const items = loadFeedItems()
    .filter(item => item.text_en)
    .map(item => ({
      ...item,
      text: item.text_en,
      html: item.html_en || item.text_en,
      media: Array.isArray(item.media_en) && item.media_en.length > 0 ? item.media_en : item.media,
      image: item.image_en || item.image,
      canonical_url: `https://alexgetman.com/en/posts/${item.message_id || item.id?.split(':').pop()}/`,
      ru_url: `https://alexgetman.com/ru/posts/${item.message_id || item.id?.split(':').pop()}/`
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  return new Response(JSON.stringify({ items }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }
  });
}
