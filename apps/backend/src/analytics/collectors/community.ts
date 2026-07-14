import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import type { MetricTask } from "../metric-schedule.js";
import type { MetricResult } from "./types.js";

type DevtoMetrics = {
  id?: number;
  slug?: string;
  url?: string;
  page_views_count?: number;
  public_reactions_count?: number;
  positive_reactions_count?: number;
  comments_count?: number;
};

export async function collectDevto(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const match = (task.url ?? task.externalId ?? "").match(/dev\.to\/([^/]+)\/([^/?#]+)/);
  if (!match) throw new Error("missing_devto_article_path");
  const [, username, slug] = match;
  let article: DevtoMetrics | undefined;
  let source = "devto_api_public";
  if (config.DEVTO_API_KEY) {
    for (let page = 1; page <= 5 && !article; page += 1) {
      const data = await requestJson<DevtoMetrics[]>(fetchImpl, `https://dev.to/api/articles/me?per_page=100&page=${page}`, {
        headers: { "api-key": config.DEVTO_API_KEY, "User-Agent": "alexgetman-backend/1.0" },
      });
      article = data.find((item) => item.slug === slug || item.url?.replace(/\/$/, "") === task.url?.replace(/\/$/, ""));
      if (data.length === 0) break;
    }
    if (article) source = "devto_api_authenticated";
  }
  article ??= await requestJson<DevtoMetrics>(fetchImpl, `https://dev.to/api/articles/${username}/${slug}`, {
    headers: { "User-Agent": "alexgetman-backend/1.0" },
  });
  return {
    metrics: {
      views: Number(article.page_views_count ?? 0),
      likes: Number(article.public_reactions_count ?? article.positive_reactions_count ?? 0),
      replies: Number(article.comments_count ?? 0),
    },
    source,
    raw: { api_id: article.id ?? null, slug: slug ?? null },
  };
}

export async function collectBluesky(task: MetricTask, fetchImpl: typeof fetch): Promise<MetricResult> {
  const ids = task.externalIds.filter((id) => id.startsWith("at://"));
  if (ids.length === 0) throw new Error("missing_bluesky_uris");
  const query = new URLSearchParams();
  for (const id of ids) query.append("uris", id);
  const result = await requestJson<{
    posts?: Array<{ uri?: string; likeCount?: number; replyCount?: number; repostCount?: number; quoteCount?: number }>;
  }>(fetchImpl, `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?${query}`);
  const totals = { likes: 0, replies: 0, reposts: 0, quotes: 0 };
  for (const post of result.posts ?? []) {
    totals.likes += Number(post.likeCount ?? 0);
    totals.replies += Number(post.replyCount ?? 0);
    totals.reposts += Number(post.repostCount ?? 0);
    totals.quotes += Number(post.quoteCount ?? 0);
  }
  return { metrics: totals, source: "bluesky_public_api", raw: result };
}

export async function collectMastodon(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const ids = task.externalIds
    .map((id) => id.match(/\/(\d+)(?:$|[?#])/)?.[1] ?? (/^\d+$/.test(id) ? id : null))
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) throw new Error("missing_mastodon_status_ids");
  const configuredHost = config.MASTODON_INSTANCE ?? "https://mastodon.social";
  const host = `${/^https?:\/\//i.test(configuredHost) ? "" : "https://"}${configuredHost}`.replace(/\/$/, "");
  const totals = { likes: 0, replies: 0, reposts: 0 };
  const parts = [];
  for (const id of ids) {
    const status = await requestJson<{ favourites_count?: number; replies_count?: number; reblogs_count?: number }>(
      fetchImpl,
      `${host}/api/v1/statuses/${id}`,
    );
    const part = {
      id,
      likes: Number(status.favourites_count ?? 0),
      replies: Number(status.replies_count ?? 0),
      reposts: Number(status.reblogs_count ?? 0),
    };
    totals.likes += part.likes;
    totals.replies += part.replies;
    totals.reposts += part.reposts;
    parts.push(part);
  }
  return { metrics: totals, source: "mastodon_public_api", raw: { parts } };
}

export async function collectGitHub(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  if (!config.GITHUB_DISCUSSIONS_TOKEN) throw new Error("missing_github_discussions_token");
  const match = (task.url ?? task.externalId ?? "").match(/github\.com\/([^/]+)\/([^/]+)\/discussions\/(\d+)/);
  if (!match) throw new Error("missing_github_discussion_url");
  const [, owner, repo, number] = match;
  const result = await requestJson<{
    data?: { repository?: { discussion?: { comments?: { totalCount?: number }; reactions?: { totalCount?: number } } } };
  }>(fetchImpl, "https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.GITHUB_DISCUSSIONS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "alexgetman-backend/1.0",
    },
    body: JSON.stringify({
      query:
        "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){discussion(number:$number){comments{totalCount} reactions{totalCount}}}}",
      variables: { owner, repo, number: Number(number) },
    }),
  });
  const discussion = result.data?.repository?.discussion;
  return {
    metrics: { likes: Number(discussion?.reactions?.totalCount ?? 0), replies: Number(discussion?.comments?.totalCount ?? 0) },
    source: "github_graphql",
    raw: { owner: owner ?? null, repo: repo ?? null, number: number ?? null },
  };
}
