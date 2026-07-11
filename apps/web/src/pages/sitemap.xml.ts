import { loadFeedItems } from "../utils/feed";

export const prerender = false;

export async function GET(context: any) {
  const siteUrl = context.site ? context.site.toString().replace(/\/$/, "") : "https://alexgetman.com";
  const pages = loadFeedItems().flatMap((item) => {
    const urls: string[] = [];
    if (item.has_en && item.post_id && item.slug_en) urls.push(`${siteUrl}/${item.post_id}/${item.slug_en}/`);
    if (item.has_ru && item.post_id && item.slug_ru) urls.push(`${siteUrl}/ru/${item.post_id}/${item.slug_ru}/`);
    return urls;
  });
  const urls = [`${siteUrl}/`, `${siteUrl}/ru/`, ...pages];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((url) => `  <url><loc>${url}</loc></url>`)
    .join("\n")}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
