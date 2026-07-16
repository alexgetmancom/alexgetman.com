import type { BackendDb } from "../../db/client.js";
import { creatorProfiles } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { ORDERED_TARGETS } from "./assets.js";
import { shortPipelineText } from "./format.js";
import { escapeHtml } from "./html.js";
import type { OpsPayload } from "./types.js";

/** Reuses the Analytics read model; Command Center only renders it. */
export function renderAudienceSection(backendDb: BackendDb, config: BackendConfig): string {
  if (!config.studio.modules.analytics) return "";
  const rows = backendDb.db
    .select()
    .from(creatorProfiles)
    .all()
    .map((profile) => {
      const data = profile.dataJson as Record<string, unknown>;
      return {
        platform: profile.platform,
        account: String(data.username ?? data.title ?? profile.platform),
        followers: metric(data.subscriberCount ?? data.followersCount),
        stars: metric(data.stars),
        views: metric(data.averageViewsPerPost),
      };
    })
    .sort((left, right) => right.followers - left.followers || left.platform.localeCompare(right.platform));
  if (!rows.length) return "";
  const cards = rows
    .map((item) => `<span class="audience-card"><strong>${escapeHtml(label(item.platform))}</strong><b>${item.followers || "—"}</b></span>`)
    .join("");
  const details = rows
    .map(
      (item) =>
        `<tr><td>${escapeHtml(label(item.platform))}</td><td>${escapeHtml(item.account)}</td><td>${item.followers || "—"}</td><td>${item.stars || "—"}</td><td>${item.views || "—"}</td></tr>`,
    )
    .join("");
  return `<div class="audience-strip"><div class="audience-cards">${cards}</div><details><summary>Показать больше</summary><div class="table-wrap"><table><thead><tr><th>Площадка</th><th>Аккаунт</th><th>Подписчики</th><th>Stars</th><th>Ср. просмотры/пост</th></tr></thead><tbody>${details}</tbody></table></div></details></div>`;
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

function label(platform: string): string {
  return platform.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
