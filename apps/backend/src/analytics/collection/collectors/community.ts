import { requestJson } from "../../../foundation/http.js";
import type { MetricTask } from "../metric-schedule.js";
import type { MetricResult } from "./types.js";

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
