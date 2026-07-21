export async function GET(context: any) {
  const siteUrl = context.site ? context.site.toString().replace(/\/$/, "") : "https://alexgetman.com";
  const host = context.site ? context.site.host : "alexgetman.com";

  const body = `User-agent: *
Allow: /
Disallow: /stats
Disallow: /stats/pageview

Sitemap: ${siteUrl}/sitemap.xml
Host: ${host}
Content-Signal: ai-train=yes, search=yes, ai-input=yes
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
