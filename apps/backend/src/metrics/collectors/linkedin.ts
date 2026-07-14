import type { BackendConfig } from "../../config.js";
import { requestJson } from "../../delivery/social/http.js";
import type { MetricTask } from "../schedule.js";
import type { MetricResult } from "./types.js";

export async function collectLinkedIn(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  if (!config.LINKEDIN_ACCESS_TOKEN || !task.externalId) throw new Error("missing_linkedin_token_or_id");
  const response = await requestJson<{ likesSummary?: { totalLikes?: number }; commentsSummary?: { totalFirstLevelComments?: number } }>(
    fetchImpl,
    `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(task.externalId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.LINKEDIN_ACCESS_TOKEN}`,
        "Linkedin-Version": config.LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
      },
    },
  );
  return {
    metrics: {
      likes: Number(response.likesSummary?.totalLikes ?? 0),
      replies: Number(response.commentsSummary?.totalFirstLevelComments ?? 0),
    },
    source: "linkedin_social_actions",
    raw: response,
  };
}
