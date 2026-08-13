import type { APIRoute } from "astro";
import { siteUrlFromContext } from "../../utils/site";

/** RFC 8414. This Studio issues no tokens — the Studio bearer token is minted
 * by its operator — so the grant and response lists are deliberately empty. The
 * document exists because MCP clients probe for it before falling back. */
export const prerender = false;

export const GET: APIRoute = (context) => {
  const body = {
    issuer: siteUrlFromContext(context),
    scopes_supported: ["read:feed"],
    response_types_supported: [],
    grant_types_supported: [],
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
