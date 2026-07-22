import { metricNumber } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import { creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { ORDERED_TARGETS, PLATFORM_ICONS } from "./assets.js";
import { formatMetricValue, shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import type { OpsPayload } from "./types.js";

type AudiencePlatform = { key: string; label: string; metricTargets: string[] };

/** The catalogue is a presentation projection over platform profiles and the
 * generic metric ledger. A missing value stays visible as —: it must never
 * erase a connected publishing target from the operator's view. */
const AUDIENCE_PLATFORMS: AudiencePlatform[] = [
  { key: "threads_ru", label: "Threads RU", metricTargets: ["threads_ru"] },
  { key: "threads_en", label: "Threads EN", metricTargets: ["threads_en"] },
  { key: "telegram", label: "Telegram", metricTargets: ["telegram"] },
  { key: "x", label: "X", metricTargets: ["x"] },
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
  const rows = AUDIENCE_PLATFORMS.map((platform) => {
    const data = (profiles.get(platform.key) ?? {}) as Record<string, unknown>;
    const followers = metricNumber(data.subscriberCount ?? data.followersCount);
    return {
      ...platform,
      followers,
      stars: metricNumber(data.stars),
    };
  });
  return `<aside class="audience-panel"><div class="section-kicker">Аудитория</div><div class="audience-list">${rows.map((item) => `<div class="audience-line"><span class="audience-line__label"><i>${PLATFORM_ICONS[item.key.startsWith("threads") ? "threads" : item.key] ?? ""}</i>${escapeHtml(item.label)}</span><strong>${followersLabel(item)}</strong></div>`).join("")}</div></aside>`;
}

export function renderRepairSection(ref: string, messageId: string): string {
  const options = ORDERED_TARGETS.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`).join(
    "\n",
  );
  return `<section><p class="note">Все внешние действия журналируются. «Заменить медиа» удаляет старую внешнюю публикацию на поддерживаемых платформах и ставит новую в очередь; «Удалить → опубликовать» делает то же без изменения контента. «Обновить сайт» пересобирает только выбранную языковую версию сайта.</p><form method="post" action="/api/command-center/action"><input name="token" type="hidden" value=""><select name="action"><option value="republish">Republish</option><option value="refresh_site">Refresh site only</option><option value="edit">Edit text</option><option value="replace_media">Replace image / video</option><option value="use_other_media">Use other locale media</option><option value="delete">Delete external publication</option><option value="delete_republish">Delete → republish</option></select><select name="locale"><option value="">both locales</option><option value="ru">RU</option><option value="en">EN</option></select><input name="ref" placeholder="post id / post:key / msg:id" value="${escapeHtml(ref)}"><input name="message_id" placeholder="telegram message id" value="${escapeHtml(messageId)}"><select name="target"><option value="">all selected targets</option>${options}</select><textarea name="text" placeholder="Replacement text for selected locale"></textarea><textarea name="media_json" placeholder='Media JSON, example: [{"type":"photo","file_id":"..."}]'></textarea><button type="submit">Apply</button></form></section>`;
}

export function renderQueueSection(ops: OpsPayload): string {
  const drafts =
    (ops.drafts ?? [])
      .map(
        (row) =>
          `<tr><td>${Number(row.id)}</td><td>${escapeHtml(row.status)}</td><td class="wide">${escapeHtml(shortPipelineText(row.textRu, 20))}</td><td>${escapeHtml(row.scheduledAt)}</td><td>${escapeHtml(row.scheduledEnAt)}</td><td>${escapeHtml(row.channelMessageId)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='7'>empty</td></tr>";
  const jobs =
    (ops.jobs ?? [])
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.jobId)}</td><td>${escapeHtml(row.postId)}</td><td>${escapeHtml(row.messageId)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status)}</td><td>${Number(row.attemptCount ?? 0)}</td><td>${escapeHtml(row.publishAt)}</td><td>${escapeHtml(row.nextAttemptAt)}</td><td class="wide">${escapeHtml(row.lastError)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='10'>empty</td></tr>";
  return `<section><h2>Drafts</h2><table><thead><tr><th>ID</th><th>Status</th><th>RU</th><th>RU slot</th><th>EN slot</th><th>Message</th><th>Updated</th></tr></thead><tbody>${drafts}</tbody></table></section><section><h2>Queue</h2><table><thead><tr><th>Job</th><th>Post</th><th>Telegram msg</th><th>Target</th><th>Status</th><th>Attempts</th><th>Publish at</th><th>Retry at</th><th>Error</th><th>Updated</th></tr></thead><tbody>${jobs}</tbody></table></section>`;
}

export function renderCredentialsSection(ops: OpsPayload): string {
  const rows =
    (ops.credentials ?? [])
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status)}</td><td>${escapeHtml(row.missingEnvJson || row.lastError)}</td><td>${escapeHtml(row.lastCheckedAt)}</td></tr>`,
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
          `<tr><td>${escapeHtml(row.messageId)}</td><td>${escapeHtml(row.target)}</td><td>${escapeHtml(row.status ?? "failed")}</td><td class="wide">${escapeHtml(row.error)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";
  const lifecycle =
    (ops.lifecycle ?? [])
      .slice(0, 30)
      .map(
        (row) =>
          `<tr><td>${escapeHtml(row.postKey)}</td><td>${escapeHtml(row.state)}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(row.updatedAt)}</td></tr>`,
      )
      .join("\n") || "<tr><td colspan='4'>empty</td></tr>";
  return `<section><h2>Errors</h2><table><thead><tr><th>Message</th><th>Target</th><th>Status</th><th>Error</th></tr></thead><tbody>${errors}</tbody></table></section><section><h2>Lifecycle</h2><table><thead><tr><th>Message</th><th>State</th><th>Reason</th><th>Updated</th></tr></thead><tbody>${lifecycle}</tbody></table></section>`;
}

function followersLabel(item: { followers: number; stars: number }): string {
  const followers = item.followers ? formatMetricValue(item.followers) : "—";
  return item.stars ? `${followers} · ★${formatMetricValue(item.stars)}` : followers;
}
