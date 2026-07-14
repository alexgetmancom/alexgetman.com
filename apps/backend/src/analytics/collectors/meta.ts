import { requestJson } from "../../delivery/social/http.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { MetricTask } from "../metric-schedule.js";
import { errorMessage, terminalIfMissingRemoteObject } from "./errors.js";
import type { MetricResult } from "./types.js";

export async function collectFacebook(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token = task.target === "facebook_ru" ? config.FACEBOOK_RU_PAGE_ACCESS_TOKEN : config.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token || !task.externalId) throw new Error("missing_facebook_token_or_id");
  const base = `https://graph.facebook.com/${config.FACEBOOK_GRAPH_API_VERSION}/${task.externalId}`;
  const metrics: Record<string, number> = {};
  const errors: string[] = [];
  try {
    const url = graphUrl(`${base}/insights`, token, { metric: "post_total_media_view_unique", period: "lifetime" });
    const data = await requestJson<{ data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }>(fetchImpl, url);
    const item = data.data?.find((value) => value.name === "post_total_media_view_unique");
    if (item) metrics.views = Number(item.values?.[0]?.value ?? 0);
  } catch (error) {
    errors.push(`post insights: ${errorMessage(error)}`);
  }
  try {
    const data = await requestJson<{
      reactions?: { summary?: { total_count?: number } };
      comments?: { summary?: { total_count?: number } };
      shares?: { count?: number };
    }>(fetchImpl, graphUrl(base, token, { fields: "reactions.summary(total_count),comments.summary(total_count),shares" }));
    metrics.likes = Number(data.reactions?.summary?.total_count ?? 0);
    metrics.replies = Number(data.comments?.summary?.total_count ?? 0);
    metrics.reposts = Number(data.shares?.count ?? 0);
  } catch (error) {
    errors.push(`post fields: ${errorMessage(error)}`);
    for (const [edge, name] of [
      ["likes", "likes"],
      ["comments", "replies"],
    ] as const) {
      try {
        const data = await requestJson<{ summary?: { total_count?: number } }>(
          fetchImpl,
          graphUrl(`${base}/${edge}`, token, { summary: "total_count", limit: "0" }),
        );
        metrics[name] = Number(data.summary?.total_count ?? 0);
      } catch (edgeError) {
        errors.push(`${edge}: ${errorMessage(edgeError)}`);
      }
    }
  }
  if (metrics.views == null) {
    for (const metric of ["fb_reels_total_plays", "total_video_views"]) {
      try {
        const data = await requestJson<{ data?: Array<{ name?: string; values?: Array<{ value?: number }> }> }>(
          fetchImpl,
          graphUrl(`${base}/video_insights`, token, { metric, ...(metric === "total_video_views" ? { period: "lifetime" } : {}) }),
        );
        const item = data.data?.find((value) => value.name === metric);
        if (item) metrics.views = Number(item.values?.at(-1)?.value ?? 0);
      } catch (error) {
        errors.push(`${metric}: ${errorMessage(error)}`);
      }
      if (metrics.views != null) break;
    }
  }
  if (Object.keys(metrics).length === 0) throw new Error(`Facebook metrics failed: ${errors.join("; ")}`);
  return { metrics, source: "facebook_insights_api", raw: { external_id: task.externalId, errors } };
}

export async function collectInstagramStory(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token =
    task.target === "instagram_stories_ru"
      ? (config.INSTAGRAM_RU_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN)
      : (config.INSTAGRAM_EN_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN);
  if (!token || !task.externalId) throw new Error("missing_instagram_story_token_or_id");
  const host = token.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
  const version = host === "graph.instagram.com" ? config.INSTAGRAM_GRAPH_API_VERSION : config.FACEBOOK_GRAPH_API_VERSION;
  let insights: { data?: Array<{ name?: string; values?: Array<{ value?: number }> }> };
  try {
    insights = await requestJson(
      fetchImpl,
      graphUrl(`https://${host}/${version}/${task.externalId}/insights`, token, {
        metric: "views,reach,replies,shares,total_interactions,navigation",
      }),
    );
  } catch (error) {
    throw terminalIfMissingRemoteObject(error);
  }
  const values = Object.fromEntries((insights.data ?? []).map((item) => [item.name ?? "", Number(item.values?.[0]?.value ?? 0)]));
  let likes = 0;
  try {
    likes = Number(
      (
        await requestJson<{ like_count?: number }>(
          fetchImpl,
          graphUrl(`https://${host}/${version}/${task.externalId}`, token, { fields: "like_count,comments_count" }),
        )
      ).like_count ?? 0,
    );
  } catch {
    // Story insights remain useful even when media fields have expired.
  }
  return {
    metrics: {
      views: values.views ?? values.reach ?? 0,
      reach: values.reach ?? 0,
      likes,
      replies: values.replies ?? 0,
      reposts: values.shares ?? 0,
      total_interactions: values.total_interactions ?? 0,
      navigation: values.navigation ?? 0,
    },
    source: "instagram_graph_api",
    raw: insights,
  };
}

function graphUrl(base: string, token: string, query: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.searchParams.set("access_token", token);
  return url.toString();
}
