import type { APIRoute } from "astro";
import { readFeedSkill } from "../../../../server/agent-skill";
import { siteUrlFromContext } from "../../../../utils/site";

export const prerender = false;

export const GET: APIRoute = (context) => {
  return new Response(readFeedSkill(siteUrlFromContext(context)), {
    headers: { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
