import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { formatZonedDateTime } from "../../foundation/time.js";
import { studioServices } from "../../studio/services/index.js";

/**
 * Studio section of the Command Center: a second adapter over the same
 * studioServices Telegram and MCP use. Read-only beyond acknowledging a
 * notification - no business logic lives here, only rendering of what the
 * services already return.
 */
export function renderStudioSection(config: BackendConfig, backendDb: BackendDb, actorId: number, locale: StudioLocale): string {
  const data = studioServices(backendDb, config).dashboard(actorId, locale);
  const zone = { timeZone: config.TIMEZONE, label: config.TIMEZONE_LABEL };
  return `
    <nav class="studio-locale">
      <a href="/command-center?tab=studio&locale=ru" class="${locale === "ru" ? "active" : ""}">RU</a>
      <a href="/command-center?tab=studio&locale=en" class="${locale === "en" ? "active" : ""}">EN</a>
    </nav>
    <section class="studio-analytics">${mdToHtml(data.analytics.text)}</section>
    <section>
      <h2>Очередь</h2>
      ${renderQueueTable("Ближайшее", data.queue.upcoming, zone)}
      ${renderQueueTable("Черновики", data.queue.drafts, zone)}
      ${renderAttention(data.queue.attention)}
    </section>
    <section>
      <h2>Уведомления</h2>
      ${renderNotifications(data.notifications, zone)}
    </section>`;
}

type QueueItem = { id: number; label: string; time: Date; kind: "post" | "video"; targets: number };
type AttentionItem = { id: number; label: string; kind: "post" | "video" };
type NotificationRow = { id: number; message: string; severity: string; createdAt: string };

function renderQueueTable(title: string, items: QueueItem[], zone: { timeZone: string; label: string }): string {
  if (!items.length) return `<h3>${title}</h3><p class="note">Пусто.</p>`;
  const rows = items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td>${item.kind}</td><td>${item.targets}</td><td class="nowrap">${escapeHtml(formatZonedDateTime(item.time, zone.timeZone, zone.label))}</td></tr>`,
    )
    .join("");
  return `<h3>${title}</h3><table><thead><tr><th>Название</th><th>Тип</th><th>Площадки</th><th>Время</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAttention(items: AttentionItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item) => `<li>${item.kind === "video" ? "🎬" : "📝"} ${escapeHtml(item.label)}</li>`).join("");
  return `<h3>Требует внимания</h3><ul class="attention-list">${rows}</ul>`;
}

function renderNotifications(events: NotificationRow[], zone: { timeZone: string; label: string }): string {
  if (!events.length) return '<p class="note">Уведомлений нет.</p>';
  const rows = events
    .map(
      (event) =>
        `<li class="notification notification--${escapeHtml(event.severity)}"><span>${escapeHtml(event.message)}</span><time>${escapeHtml(formatZonedDateTime(event.createdAt, zone.timeZone, zone.label))}</time><form method="post" action="/command-center/studio/acknowledge"><input type="hidden" name="id" value="${event.id}"><button type="submit">Прочитано</button></form></li>`,
    )
    .join("");
  return `<ul class="notification-list">${rows}</ul>`;
}

/** The analytics text is Telegram Markdown (bold + newlines only); render just enough of it. */
function mdToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*(.+?)\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
