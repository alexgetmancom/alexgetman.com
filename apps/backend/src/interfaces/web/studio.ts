import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { escapeHtml } from "../../foundation/html.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { formatZonedDateTime } from "../../foundation/time.js";
import { createStudioServices } from "../../studio/services/index.js";
import { localeQuery, renderLocaleSwitcher } from "./dashboard/locale-links.js";

/**
 * Studio section of the Command Center: a second adapter over the same
 * createStudioServices Telegram and MCP use. Read-only beyond acknowledging a
 * no business logic lives here, only rendering of what the services return.
 */
export function renderStudioSection(config: BackendConfig, backendDb: BackendDb, actorId: number, locale: StudioLocale): string {
  const data = createStudioServices(backendDb, config).dashboard(actorId, locale);
  const channels = createStudioServices(backendDb, config).channels;
  const zone = { timeZone: config.TIMEZONE, label: config.TIMEZONE_LABEL };
  return `
    <nav class="studio-toolbar">${renderLocaleSwitcher(locale, (target) => `/command-center?tab=studio${localeQuery(target)}`)}</nav>
    ${renderChannels(channels, locale)}
    <section class="studio-analytics">${mdToHtml(data.analytics.text)}</section>
    <section>
      <h2>${t(locale, "cc.studio.queue")}</h2>
      ${renderQueueTable(t(locale, "cc.studio.upcoming"), data.queue.upcoming, zone, locale)}
      ${renderQueueTable(t(locale, "cc.studio.drafts"), data.queue.drafts, zone, locale)}
      ${renderAttention(data.queue.attention, locale)}
    </section>`;
}

function renderChannels(channels: ReturnType<typeof createStudioServices>["channels"], locale: StudioLocale): string {
  const connected = channels
    .list()
    .map((channel) => `<li>${escapeHtml(channel.label)} — ${escapeHtml(channel.provider)}</li>`)
    .join("");
  const metaButtons = (["threads", "instagram"] as const)
    .flatMap((platform) =>
      (["ru", "en"] as const).flatMap((targetLocale) => {
        const url = channels.nativeConnectPath(platform, targetLocale);
        return url
          ? [
              `<a class="period-quick-link" href="${escapeHtml(url)}">${t(locale, "cc.studio.connect-native", { platform: platform === "threads" ? "Threads" : "Instagram", locale: targetLocale.toUpperCase() })}</a>`,
            ]
          : [];
      }),
    )
    .join(" ");
  const xUrl = channels.xConnectPath();
  const buttons = [
    metaButtons,
    xUrl
      ? `<a class="period-quick-link" href="${escapeHtml(xUrl)}">${t(locale, "cc.studio.connect-native", { platform: "X", locale: "EN" })}</a>`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<section><h2>${t(locale, "cc.studio.channels")}</h2>${connected ? `<ul>${connected}</ul>` : `<p class="note">${t(locale, "settings.channels-none")}</p>`}${buttons ? `<nav class="studio-toolbar">${buttons}</nav>` : `<p class="note">${t(locale, "cc.studio.native-unconfigured")}</p>`}</section>`;
}

type QueueItem = { id: number; label: string; time: Date; kind: "post" | "video"; targets: number };
type AttentionItem = { id: number; label: string; kind: "post" | "video" };

function renderQueueTable(title: string, items: QueueItem[], zone: { timeZone: string; label: string }, locale: StudioLocale): string {
  if (!items.length) return `<h3>${title}</h3><p class="note">${t(locale, "cc.studio.empty")}</p>`;
  const rows = items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td>${item.kind}</td><td>${item.targets}</td><td class="nowrap">${escapeHtml(formatZonedDateTime(item.time, zone.timeZone, zone.label))}</td></tr>`,
    )
    .join("");
  return `<h3>${title}</h3><table><thead><tr><th>${t(locale, "cc.studio.name")}</th><th>${t(locale, "cc.studio.type")}</th><th>${t(locale, "cc.studio.platforms")}</th><th>${t(locale, "cc.studio.time")}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAttention(items: AttentionItem[], locale: StudioLocale): string {
  if (!items.length) return "";
  const rows = items.map((item) => `<li>${item.kind === "video" ? "🎬" : "📝"} ${escapeHtml(item.label)}</li>`).join("");
  return `<h3>${t(locale, "cc.studio.attention")}</h3><ul class="attention-list">${rows}</ul>`;
}

/** The analytics text is Telegram Markdown (bold + newlines only); render just enough of it. */
function mdToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*(.+?)\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}
