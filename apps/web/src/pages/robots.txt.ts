import type { APIRoute } from "astro";
import { siteUrlFromContext } from "../utils/site";

export const GET: APIRoute = (context) => {
  const siteUrl = siteUrlFromContext(context);
  const host = new URL(siteUrl).host;

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
};
