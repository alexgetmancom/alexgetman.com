import crypto from "node:crypto";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { payloadMedia, payloadText, payloadTitle } from "./payload.js";

type GitHubGraphQLError = { message?: string; type?: string };

type GitHubDiscussionResponse = {
  data?: {
    createDiscussion?: {
      discussion?: {
        id?: string;
        url?: string;
      };
    };
  };
  errors?: GitHubGraphQLError[];
};

// GitHub's GraphQL endpoint always answers HTTP 200, even when the mutation
// itself failed - errors ride inside the body instead of the status code, so
// they never reach requestJson's throw path or the shared HTTP classifier.
// Each error carries its own `type`; only genuinely transient ones should be
// retried; https://docs.github.com/en/graphql/overview/handling-errors.
const retryableGraphQLErrorTypes = new Set(["RATE_LIMITED", "INTERNAL", "SERVICE_UNAVAILABLE"]);

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
    // completePublishJob only re-queues a failed PublishResult when it carries
    // external ids to reconcile against (see queue.ts); a discussion that never
    // got created has none, so a returned `{ ok: false }` here would always be
    // terminal regardless of `retryable`. Throwing instead routes through
    // failPublishJob's normal retry/backoff policy for the transient types.
    const retryable = data.errors.some((error) => error.type != null && retryableGraphQLErrorTypes.has(error.type));
    // The "temporarily" marker steers classifyPublishError (errors.ts) to the
    // "transient" class so this gets the normal backoff budget rather than the
    // single fallback retry "unknown" errors get.
    if (retryable) throw new Error(`GitHub GraphQL error, temporarily unavailable: ${JSON.stringify(data.errors)}`);
    return { ok: false, error: `GitHub GraphQL error: ${JSON.stringify(data.errors)}`, retryable: false };
  }
  const discussion = data.data?.createDiscussion?.discussion;
  return {
    ok: Boolean(discussion?.url || discussion?.id),
    id: discussion?.id ?? discussion?.url ?? null,
    url: discussion?.url ?? null,
    raw: data,
  };
}
