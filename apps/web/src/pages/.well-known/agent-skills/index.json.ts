import type { APIRoute } from "astro";
import { READ_FEED_DESCRIPTION, READ_FEED_SKILL, readFeedSkill, skillDigest } from "../../../server/agent-skill";
import { siteUrlFromContext } from "../../../utils/site";

export const prerender = false;

export const GET: APIRoute = (context) => {
  const site = siteUrlFromContext(context);
  const url = `/.well-known/agent-skills/${READ_FEED_SKILL}/SKILL.md`;
  const body = {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: READ_FEED_SKILL,
        description: READ_FEED_DESCRIPTION,
        url,
        digest: skillDigest(readFeedSkill(site)),
      },
    ],
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
