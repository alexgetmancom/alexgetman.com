import { loadFeedItems } from "../server/public-site";

export const prerender = false;

export async function GET() {
  const items = loadFeedItems()
    .filter((item) => item.has_en && item.text_en && item.post_id)
    .map((item) => ({
      ...item,
      text: item.text_en,
      html: item.html_en || item.text_en,
      media: Array.isArray(item.media_en) && item.media_en.length > 0 ? item.media_en : item.media,
      image: item.image_en || item.image,
      canonical_url: `https://alexgetman.com/${item.post_id}/${item.slug_en}/`,
      ru_url: item.has_ru ? `https://alexgetman.com/ru/${item.post_id}/${item.slug_ru}/` : null,
    }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 50);

  return new Response(JSON.stringify({ items }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=60",
    },
  });
}
