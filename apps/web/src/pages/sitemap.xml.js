export async function GET(context) {
  const siteUrl = context.site ? context.site.toString().replace(/\/$/, '') : 'https://alexgetman.com';
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <sitemap>\n    <loc>${siteUrl}/sitemap-0.xml</loc>\n  </sitemap>\n</sitemapindex>\n`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8'
    }
  });
}
