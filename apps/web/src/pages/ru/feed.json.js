import { loadFeedItems } from '../../utils/content-feed.js';

export async function GET() {
  const items = loadFeedItems()
    .filter(item => item.has_ru && item.post_id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  return new Response(JSON.stringify({ items }, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60'
    }
  });
}
