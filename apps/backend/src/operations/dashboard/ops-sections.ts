import { audienceGrowthByAccount, KEY_SEP, metricSeriesSince } from "../../analytics/metric-deltas.js";
import type { BackendDb } from "../../db/client.js";
import { creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { ORDERED_TARGETS } from "./assets.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import type { OpsPayload } from "./types.js";

type AudiencePlatform = { key: string; label: string; metricTargets: string[] };
type PeriodMetrics = { views: number; interactions: number };

/** The catalogue is a presentation projection over platform profiles and the
 * generic metric ledger. A missing value stays visible as —: it must never
 * erase a connected publishing target from the operator's view. */
const AUDIENCE_PLATFORMS: AudiencePlatform[] = [
  { key: "telegram", label: "Telegram", metricTargets: ["telegram"] },
  { key: "threads_ru", label: "Threads RU", metricTargets: ["threads_ru"] },
  { key: "threads_en", label: "Threads EN", metricTargets: ["threads_en"] },
  { key: "facebook_ru", label: "Facebook RU", metricTargets: ["facebook_ru"] },
  { key: "facebook_en", label: "Facebook EN", metricTargets: ["facebook"] },
  { key: "instagram", label: "Instagram", metricTargets: ["instagram_stories_ru", "instagram_stories"] },
  { key: "linkedin", label: "LinkedIn", metricTargets: ["linkedin"] },
  { key: "x", label: "X", metricTargets: ["x"] },
  { key: "bluesky", label: "Bluesky", metricTargets: ["bluesky"] },
  { key: "mastodon", label: "Mastodon", metricTargets: ["mastodon"] },
  { key: "devto", label: "Dev.to", metricTargets: ["devto"] },
  { key: "github", label: "GitHub", metricTargets: ["github_ru", "github_en"] },
];

/** Reuses Analytics projections and metric samples; Command Center only renders them. */
export function renderAudienceSection(backendDb: BackendDb, config: BackendConfig): string {
  if (!config.studio.modules.analytics) return "";
  const profiles = new Map(
    backendDb.db
      .select()
      .from(creatorProfiles)
      .all()
      .map((profile) => [profile.platform, profile.dataJson]),
  );
  const followerGrowth7 = followerGrowth(backendDb, 7);
  const followerGrowth30 = followerGrowth(backendDb, 30);
  const metrics7 = targetPeriodMetrics(backendDb, 7);
  const metrics30 = targetPeriodMetrics(backendDb, 30);
  const rows = AUDIENCE_PLATFORMS.map((platform) => {
    const data = (profiles.get(platform.key) ?? {}) as Record<string, unknown>;
    const followers = metric(data.subscriberCount ?? data.followersCount);
    return {
      ...platform,
      followers,
      stars: metric(data.stars),
      growth7: followerGrowth7.get(platform.key),
      growth30: followerGrowth30.get(platform.key),
      metrics7: sumTargetMetrics(metrics7, platform.metricTargets),
      metrics30: sumTargetMetrics(metrics30, platform.metricTargets),
    };
  }).sort((left, right) => right.followers - left.followers || left.label.localeCompare(right.label));
  const cards = rows
    .map((item) => `<span class="audience-card"><strong>${escapeHtml(item.label)}</strong><b>${followersLabel(item)}</b></span>`)
    .join("");
  const details = rows
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td>${followersLabel(item)}</td><td>${delta(item.growth7)}</td><td>${delta(item.growth30)}</td><td>${metricCell(item.metrics7.views)}</td><td>${metricCell(item.metrics7.interactions)}</td><td>${metricCell(item.metrics30.views)}</td><td>${metricCell(item.metrics30.interactions)}</td></tr>`,
    )
    .join("");
  return `<div class="audience-strip"><div class="audience-cards">${cards}</div><details><summary>Показать больше</summary><div class="table-wrap"><table><thead><tr><th>Площадка</th><th>Подписчики</th><th>Δ 7д</th><th>Δ 30д</th><th>Просмотры 7д</th><th>Реакции 7д</th><th>Просмотры 30д</th><th>Реакции 30д</th></tr></thead><tbody>${details}</tbody></table></div></details></div>`;
}

export function renderRepairSection(ref: string, messageId: string): string {
  const options = ORDERED_TARGETS.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`).join(
    "\n",
  );
  return `<section><p class="note">Действия не удаляют и не снимают опубликованные посты: только retry / republish и правка EN-версии. Все вызовы записываются в audit.</p><form method="post" action="/api/command-center/action"><input name="token" type="hidden" value=""><select name="action"><option value="retry">Retry / republish</option><option value="edit_en">Edit EN</option><option value="replace_en_media">Replace EN media</option><option value="use_ru_media_for_en">Use RU media for EN</option></select><input name="ref" placeholder="post id / post:key / msg:id" value="${escapeHtml(ref)}"><input name="message_id" placeholder="telegram message id (edit/media only)" value="${escapeHtml(messageId)}"><select name="target"><option value="">all targets</option>${options}</select><textarea name="text_en" placeholder="EN text for edit_en"></textarea><textarea name="media_en_json" placeholder='EN media JSON, example: [{"type":"photo","file_id":"..."}]'></textarea><button type="submit">Apply</button></form></section>`;
}

export function renderQueueSection(ops: OpsPayload): string {
  const drafts =
    (ops.drafts ?? [])
      .map(
        (row) =>
          `<tr><td>${Number(row.id)}</td><td>${escapeHtml(row.status)}</td><td class="wide">${escapeHtml(shortPipelineText(row.text_ru, 20))}</td><td>${escapeHtml(row.scheduled_at)}</td><td>${escapeHtml(row.scheduled_en_at)}</td><td>${escapeHtml(row.channel_message_id)}</td><td>${escapeHtml(row.updated_at)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='7'>empty</td></tr>";
  const jobs =
    (ops.jobs ?? [])
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.job_id ?? row.jobId)}</td><td>${escapeHtml(row.post_id ?? row.postId)}</td><td>${escapeHtml(row.message_id ?? row.messageId)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status)}</td><td>${Number(row.attempt_count ?? row.attemptCount ?? 0)}</td><td>${escapeHtml(row.publish_at ?? row.publishAt)}</td><td>${escapeHtml(row.next_attempt_at ?? row.nextAttemptAt)}</td><td class="wide">${escapeHtml(row.last_error ?? row.lastError)}</td><td>${escapeHtml(row.updated_at ?? row.updatedAt)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='10'>empty</td></tr>";
  return `<section><h2>Drafts</h2><table><thead><tr><th>ID</th><th>Status</th><th>RU</th><th>RU slot</th><th>EN slot</th><th>Message</th><th>Updated</th></tr></thead><tbody>${drafts}</tbody></table></section><section><h2>Queue</h2><table><thead><tr><th>Job</th><th>Post</th><th>Telegram msg</th><th>Target</th><th>Status</th><th>Attempts</th><th>Publish at</th><th>Retry at</th><th>Error</th><th>Updated</th></tr></thead><tbody>${jobs}</tbody></table></section>`;
}

export function renderCredentialsSection(ops: OpsPayload): string {
  const rows =
    (ops.credentials ?? [])
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.target ?? row.name ?? row.credential)}</td><td>${escapeHtml(row.status ?? (row.ok ? "ok" : "failed"))}</td><td>${escapeHtml(row.missing_env_json ?? row.error)}</td><td>${escapeHtml(row.last_checked_at ?? row.checked_at ?? row.updated_at)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";
  return `<section><h2>Credentials</h2><table><thead><tr><th>Target</th><th>Status</th><th>Missing</th><th>Checked</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

export function renderDiagnosticsSection(ops: OpsPayload): string {
  const errors =
    (ops.pipeline?.metrics?.recent ?? [])
      .filter((row) => row.error || row.status === "failed")
      .slice(0, 30)
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.message_id ?? row.messageId)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status ?? "failed")}</td><td class="wide">${escapeHtml(row.error)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";
  const lifecycle =
    (ops.lifecycle ?? [])
      .slice(0, 30)
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.post_key ?? row.post_id)}</td><td>${escapeHtml(row.state ?? row.status)}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.updated_at)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";
  return `<section><h2>Errors</h2><table><thead><tr><th>Message</th><th>Target</th><th>Status</th><th>Error</th></tr></thead><tbody>${errors}</tbody></table></section><section><h2>Lifecycle</h2><table><thead><tr><th>Message</th><th>State</th><th>Reason</th><th>Updated</th></tr></thead><tbody>${lifecycle}</tbody></table></section>`;
}

function metric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function followersLabel(item: { followers: number; stars: number }): string {
  const followers = item.followers ? formatMetricValue(item.followers) : "—";
  return item.stars ? `${followers} · ★${formatMetricValue(item.stars)}` : followers;
}

function delta(value: number | undefined): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${formatMetricValue(value)}`;
}

function metricCell(value: number): string {
  return value ? formatMetricValue(value) : "—";
}

function sumTargetMetrics(values: Map<string, PeriodMetrics>, targets: string[]): PeriodMetrics {
  return targets.reduce(
    (total, target) => ({
      views: total.views + (values.get(target)?.views ?? 0),
      interactions: total.interactions + (values.get(target)?.interactions ?? 0),
    }),
    { views: 0, interactions: 0 },
  );
}

/** Per-target views/interactions over the period, built on the shared metric series. */
function targetPeriodMetrics(backendDb: BackendDb, days: number): Map<string, PeriodMetrics> {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const totals = new Map<string, PeriodMetrics>();
  for (const entry of metricSeriesSince(backendDb, since)) {
    if (entry.baseline == null && entry.firstAt < since) continue;
    const row = totals.get(entry.target) ?? { views: 0, interactions: 0 };
    const deltaValue = Math.max(0, entry.latest - (entry.baseline ?? 0));
    if (entry.metric === "views" || entry.metric === "bot_views") row.views += deltaValue;
    if (["likes", "replies", "reposts", "comments"].includes(entry.metric)) row.interactions += deltaValue;
    totals.set(entry.target, row);
  }
  return totals;
}

/** Follower growth per platform, aggregating the shared per-account growth. */
function followerGrowth(backendDb: BackendDb, days: number): Map<string, number> {
  const since = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const totals = new Map<string, number>();
  for (const [key, growth] of audienceGrowthByAccount(backendDb, since)) {
    const platform = key.split(KEY_SEP)[0] ?? key;
    totals.set(platform, (totals.get(platform) ?? 0) + growth);
  }
  return totals;
}
