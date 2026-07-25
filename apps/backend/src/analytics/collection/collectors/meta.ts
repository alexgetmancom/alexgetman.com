import type { BackendConfig } from "../../../foundation/config.js";
import { requestJson } from "../../../foundation/http.js";
import type { MetricTask } from "../metric-schedule.js";
import { terminalIfMissingRemoteObject } from "./errors.js";
import type { MetricResult } from "./types.js";

export async function collectInstagramStory(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token =
    task.target === "instagram_stories_ru"
      ? (config.INSTAGRAM_RU_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN)
      : (config.INSTAGRAM_EN_ACCESS_TOKEN ?? config.INSTAGRAM_ACCESS_TOKEN);
  if (!token || !task.externalId) throw new Error("missing_instagram_story_token_or_id");
  const host = token.startsWith("IG") ? "graph.instagram.com" : "graph.facebook.com";
  const version = config.INSTAGRAM_GRAPH_API_VERSION;
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
