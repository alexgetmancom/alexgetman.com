import { createHash } from "node:crypto";

export const READ_FEED_SKILL = "read-feed";
export const READ_FEED_DESCRIPTION = "Read the latest AI news, automation notes and developer posts from this site.";

/** The skill document an agent fetches after finding it in the discovery index.
 * It is built from the install's own origin, so the index must hash this exact
 * body rather than carry a digest someone remembered to update. */
export function readFeedSkill(site: string): string {
  const host = new URL(site).host;
  return `---
name: ${READ_FEED_SKILL}
description: ${READ_FEED_DESCRIPTION}
license: MIT
---
# Read Feed Skill

This skill lets agents fetch, digest, and search posts published on ${host}.

## How to use
1. Fetch the JSON feed array from \`${site}/feed.json\`.
2. To read posts in a structured format, iterate through the \`items\` array.
3. Present the relevant posts to the user.
`;
}

export function skillDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}
