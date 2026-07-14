import type { BackendConfig } from "../../../foundation/config.js";
import { oauthAuthorization } from "../../../foundation/external/x-oauth.js";
import { externalFetch, redactExternalSecrets } from "../../../foundation/http.js";
import type { MetricTask } from "../metric-schedule.js";
import type { MetricResult } from "./types.js";

export async function collectX(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  if (!task.externalId) throw new Error("missing_x_tweet_id");
  const url = `https://api.twitter.com/2/tweets/${encodeURIComponent(task.externalId)}?tweet.fields=public_metrics`;
  const response = await externalFetch(fetchImpl, url, { headers: { Authorization: oauthAuthorization("GET", url, config) } });
  const body = await response.text();
  if (!response.ok) throw new Error(`X metrics ${response.status}: ${redactExternalSecrets(body)}`);
  const result = JSON.parse(body) as {
    data?: {
      public_metrics?: {
        impression_count?: number;
        like_count?: number;
        reply_count?: number;
        retweet_count?: number;
        quote_count?: number;
      };
    };
  };
  const metrics = result.data?.public_metrics;
  return {
    metrics: {
      views: Number(metrics?.impression_count ?? 0),
      likes: Number(metrics?.like_count ?? 0),
      replies: Number(metrics?.reply_count ?? 0),
      reposts: Number(metrics?.retweet_count ?? 0),
      quotes: Number(metrics?.quote_count ?? 0),
    },
    source: "x_api_v2",
    raw: result,
  };
}
