import type { APIRoute } from "astro";
import { siteUrlFromContext } from "../../utils/site";

/** RFC 9728. The MCP endpoint is the protected resource; the read-only feed
 * scope is the only one it grants. */
export const prerender = false;

export const GET: APIRoute = (context) => {
  const site = siteUrlFromContext(context);
  const body = {
    resource: site,
    authorization_servers: [site],
    scopes_supported: ["read:feed"],
    bearer_methods_supported: ["header"],
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
