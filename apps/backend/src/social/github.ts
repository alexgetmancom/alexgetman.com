import crypto from "node:crypto";
import type { BackendConfig } from "../config.js";
import type { PublishResult } from "../queue/errors.js";
import { requestJson } from "./http.js";
import { payloadMedia, payloadText, payloadTitle } from "./payload.js";

type GitHubDiscussionResponse = {
  data?: {
    createDiscussion?: {
      discussion?: {
        id?: string;
        url?: string;
      };
    };
  };
  errors?: unknown[];
};

export async function publishToGitHubDiscussion(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  if (!config.GITHUB_DISCUSSIONS_TOKEN) return { skipped: true, reason: "missing GITHUB_DISCUSSIONS_TOKEN" };
  const query = `
    mutation($repoId: ID!, $catId: ID!, $title: String!, $body: String!) {
      createDiscussion(input: { repositoryId: $repoId, categoryId: $catId, title: $title, body: $body }) {
        discussion { id url }
      }
    }
  `;
  const text = payload.bodyMarkdown ?? payload.body_markdown ?? payloadText(payload);
  let body = String(text ?? "");

  const media = payloadMedia(payload);
  if (media.length > 0) {
    let imgMarkdown = "";
    for (const item of media) {
      if (item.vpsUrl) {
        imgMarkdown += `\n\n![Image](${item.vpsUrl})`;
      }
    }
    body += imgMarkdown;
  }

  const title = payloadTitle(payload);
  const titleHash = crypto.createHash("sha1").update(title, "utf8").digest("hex");
  body += `\n\n<!-- sha1: ${titleHash} -->`;

  const data = await requestJson<GitHubDiscussionResponse>(fetchImpl, "https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.GITHUB_DISCUSSIONS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "alexgetman-posting",
    },
    body: JSON.stringify({
      query,
      variables: {
        repoId: config.GITHUB_DISCUSSIONS_REPO_ID,
        catId: config.GITHUB_DISCUSSIONS_CATEGORY_ID,
        title,
        body,
      },
    }),
  });
  if (data.errors?.length) {
    return { ok: false, error: JSON.stringify(data.errors), retryable: false };
  }
  const discussion = data.data?.createDiscussion?.discussion;
  return {
    ok: Boolean(discussion?.url || discussion?.id),
    id: discussion?.id ?? discussion?.url ?? null,
    url: discussion?.url ?? null,
    raw: data,
  };
}
