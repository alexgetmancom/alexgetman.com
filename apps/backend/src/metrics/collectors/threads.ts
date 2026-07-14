import type { BackendConfig } from "../../config.js";
import type { JsonValue } from "../../db/schema.js";
import { requestJson } from "../../delivery/social/http.js";
import type { MetricTask } from "../schedule.js";
import { terminalIfMissingRemoteObject } from "./errors.js";
import type { MetricResult } from "./types.js";

export async function collectThreads(task: MetricTask, config: BackendConfig, fetchImpl: typeof fetch): Promise<MetricResult> {
  const token =
    task.target === "threads_en" ? (config.THREADS_EN_ACCESS_TOKEN ?? config.THREADS_ACCESS_TOKEN) : config.THREADS_ACCESS_TOKEN;
  if (!token || task.externalIds.length === 0) throw new Error("missing_threads_token_or_id");
  const totals: Record<string, number> = {};
  const parts: JsonValue[] = [];
  for (const id of task.externalIds) {
    const url = new URL(`https://graph.threads.net/v1.0/${id}/insights`);
    url.searchParams.set("metric", config.THREADS_METRICS);
    url.searchParams.set("access_token", token);
    let result: { data?: Array<{ name?: string; values?: Array<{ value?: number }> }> };
    try {
      result = await requestJson(fetchImpl, url.toString());
    } catch (error) {
      throw terminalIfMissingRemoteObject(error);
    }
    const metrics: Record<string, number> = {};
    for (const item of result.data ?? []) if (item.name) metrics[item.name] = Number(item.values?.[0]?.value ?? 0);
    for (const [name, value] of Object.entries(metrics)) totals[name] = (totals[name] ?? 0) + value;
    parts.push({ id, metrics });
  }
  let permalink = task.url ?? undefined;
  if (!permalink && task.externalId) {
    const url = new URL(`https://graph.threads.net/v1.0/${task.externalId}`);
    url.searchParams.set("fields", "permalink");
    url.searchParams.set("access_token", token);
    permalink = (await requestJson<{ permalink?: string }>(fetchImpl, url.toString())).permalink?.replace("threads.net", "threads.com");
  }
  return { metrics: totals, source: "threads_insights_api", raw: { parts }, ...(permalink ? { url: permalink } : {}) };
}
