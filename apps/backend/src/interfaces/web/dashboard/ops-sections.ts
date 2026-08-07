import { metricNumber } from "../../../analytics/snapshots/creator-store.js";
import { AUDIENCE_VIEWS, targetDefinition } from "../../../botTargets.js";
import { hasChannelRegistry, listChannels } from "../../../channels/registry.js";
import { type BackendDb, unsafeDb } from "../../../db/client.js";
import { creatorProfiles } from "../../../db/schema.js";
import { escapeHtml } from "../../../foundation/html.js";
import { ORDERED_TARGETS } from "./assets.js";
import { shortPipelineText } from "./format.js";
import type { OpsPayload } from "./types.js";

type AudiencePlatform = { key: string; label: string; metricTarget: string };

/** The catalogue is a presentation projection over platform profiles and the
 * generic metric ledger. A missing value stays visible as —: it must never
 * erase a connected publishing target from the operator's view. */
const AUDIENCE_PLATFORMS: AudiencePlatform[] = AUDIENCE_VIEWS.map((key) => ({
  key,
  label: key === "x" ? "X" : (targetDefinition(key)?.label ?? key),
  metricTarget: key,
}));

/** The follower counts alone, for callers that lay the platforms out
 * themselves — the unified overview pairs them with this period's reach. */
export function audiencePlatformFollowers(backendDb: BackendDb): Array<{ key: string; label: string; followers: number | null }> {
  const platforms = activeAudiencePlatforms(backendDb);
  const profiles = new Map(
    unsafeDb(backendDb)
      .db.select()
      .from(creatorProfiles)
      .all()
      .map((profile) => [profile.platform, profile.dataJson]),
  );
  return platforms.map((platform) => {
    const data = (profiles.get(platform.key) ?? {}) as Record<string, unknown>;
    const followers = metricNumber(data.subscriberCount ?? data.followersCount);
    return { key: platform.key, label: platform.label, followers: followers > 0 ? followers : null };
  });
}

function activeAudiencePlatforms(backendDb: BackendDb): AudiencePlatform[] {
  if (!hasChannelRegistry(backendDb)) return AUDIENCE_PLATFORMS;
  const registeredTargets = new Set(
    listChannels(backendDb)
      .map((channel) => channel.targetId)
      .filter(Boolean),
  );
  return AUDIENCE_PLATFORMS.filter((platform) => registeredTargets.has(platform.metricTarget));
}

const REPAIR_ACTIONS: [value: string, label: string][] = [
  ["republish", "Republish"],
  ["refresh_site", "Refresh site only"],
  ["edit", "Edit text"],
  ["replace_media", "Replace image / video"],
  ["use_other_media", "Use other locale media"],
  ["delete", "Delete external publication"],
  ["delete_republish", "Delete → republish"],
];

const REPAIR_NOTE =
  "Все внешние действия журналируются. «Заменить медиа» удаляет старую внешнюю публикацию на поддерживаемых платформах и ставит новую в очередь; «Удалить → опубликовать» делает то же без изменения контента. «Обновить сайт» пересобирает только выбранную языковую версию сайта.";

/** The form authenticates through the HttpOnly `command_token` cookie; the
 * endpoint pairs that with a same-origin check, which is what actually stops a
 * cross-site POST from riding the session. */
export function renderRepairSection(ref: string, messageId: string): string {
  const options = ORDERED_TARGETS.map((target) => `<option value="${escapeHtml(target.id)}">${escapeHtml(target.label)}</option>`).join(
    "\n",
  );
  const actions = REPAIR_ACTIONS.map(([value, label]) => `<option value="${value}">${escapeHtml(label)}</option>`).join("");
  return [
    "<section>",
    `<p class="note">${escapeHtml(REPAIR_NOTE)}</p>`,
    '<form method="post" action="/api/command-center/action">',
    `<select name="action">${actions}</select>`,
    '<select name="locale"><option value="">both locales</option><option value="ru">RU</option><option value="en">EN</option></select>',
    `<input name="ref" placeholder="post id / post:key / msg:id" value="${escapeHtml(ref)}">`,
    `<input name="message_id" placeholder="telegram message id" value="${escapeHtml(messageId)}">`,
    `<select name="target"><option value="">all selected targets</option>${options}</select>`,
    '<textarea name="text" placeholder="Replacement text for selected locale"></textarea>',
    `<textarea name="media_json" placeholder='Media JSON, example: [{"type":"photo","file_id":"..."}]'></textarea>`,
    '<button type="submit">Apply</button>',
    "</form></section>",
  ].join("");
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
      .filter((row) => row.error || row.status === "failed" || row.status === "verification_required")
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
