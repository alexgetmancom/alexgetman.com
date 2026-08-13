import type { APIRoute } from "astro";
import { siteUrlFromContext } from "../../utils/site";

/** RFC 9727 catalog of this Studio's machine-readable entry points. Served as a
 * route rather than a file in `public/` because every href names this install's
 * own origin, and because a dotfile directory is the first thing a build or an
 * artifact upload silently drops. */
export const prerender = false;

export const GET: APIRoute = (context) => {
  const site = siteUrlFromContext(context);
  const body = {
    linkset: [
      {
        anchor: `${site}/`,
        "service-desc": [{ href: `${site}/openapi.json`, type: "application/json" }],
        "service-doc": [{ href: `${site}/llms.txt`, type: "text/plain" }],
        status: [{ href: `${site}/tg-feed/healthz`, type: "text/plain" }],
      },
    ],
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/linkset+json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
