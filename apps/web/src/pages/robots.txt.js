export async function GET(context) {
  const siteUrl = context.site ? context.site.toString().replace(/\/$/, '') : 'https://alexgetman.com';
  const host = context.site ? context.site.host : 'alexgetman.com';

  const body = `User-agent: *
Allow: /
Disallow: /stats
Disallow: /stats/pageview

Sitemap: ${siteUrl}/sitemap.xml
Sitemap: ${siteUrl}/sitemap-index.xml
Host: ${host}
Content-Signal: ai-train=no, search=yes, ai-input=no
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8'
    }
  });
}
