import { loadFeedItems } from "../server/public-site";

export const prerender = false;

function lastmod(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

export async function GET(context: any) {
  const siteUrl = context.site ? context.site.toString().replace(/\/$/, "") : "https://alexgetman.com";
  const items = loadFeedItems();
  const entries = items.flatMap((item) => {
    const urls: Array<{ loc: string; lastmod: string }> = [];
    if (item.has_en && item.post_id && item.slug_en)
      urls.push({ loc: `${siteUrl}/${item.post_id}/${item.slug_en}/`, lastmod: lastmod(item.date) });
    if (item.has_ru && item.post_id && item.slug_ru)
      urls.push({ loc: `${siteUrl}/ru/${item.post_id}/${item.slug_ru}/`, lastmod: lastmod(item.date) });
    return urls;
  });
  const newest =
    entries
      .map((entry) => entry.lastmod)
      .sort()
      .at(-1) ?? "";
  const urls = [{ loc: `${siteUrl}/`, lastmod: newest }, { loc: `${siteUrl}/ru/`, lastmod: newest }, ...entries];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((url) => `  <url><loc>${url.loc}</loc>${url.lastmod ? `<lastmod>${url.lastmod}</lastmod>` : ""}</url>`)
    .join("\n")}\n</urlset>\n`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  });
}
