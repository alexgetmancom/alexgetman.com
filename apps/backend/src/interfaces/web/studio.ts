import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { formatZonedDateTime } from "../../foundation/time.js";
import { studioServices } from "../../studio/services/index.js";

/**
 * Web Studio: a third adapter over the same studioServices Telegram and MCP use.
 * Read-only for v1 beyond acknowledging a notification - no business logic lives
 * here, only rendering of what the services already return.
 */
export function renderStudioDashboard(config: BackendConfig, backendDb: BackendDb, actorId: number, locale: StudioLocale): string {
  const data = studioServices(backendDb, config).dashboard(actorId, locale);
  const zone = { timeZone: config.TIMEZONE, label: config.TIMEZONE_LABEL };
  const body = `
    <header class="studio-heading">
      <h1>Studio</h1>
      <nav class="studio-locale"><a href="/studio?locale=ru" class="${locale === "ru" ? "active" : ""}">RU</a><a href="/studio?locale=en" class="${locale === "en" ? "active" : ""}">EN</a></nav>
    </header>
    <section class="studio-analytics">${mdToHtml(data.analytics.text)}</section>
    <section>
      <h2>Queue</h2>
      ${renderQueueTable("Upcoming", data.queue.upcoming, zone)}
      ${renderQueueTable("Drafts", data.queue.drafts, zone)}
      ${renderAttention(data.queue.attention)}
    </section>
    <section>
      <h2>Notifications</h2>
      ${renderNotifications(data.notifications, zone)}
    </section>`;
  return shell(body);
}

export function renderStudioLogin(error = false): string {
  return shell(
    `<section class="studio-login"><h1>Studio</h1><p class="note">Enter the Studio token. It is stored in a protected HttpOnly cookie for 180 days.</p>${error ? '<p class="login-error">Invalid token.</p>' : ""}<form method="post" action="/studio"><input type="password" name="token" autocomplete="current-password" aria-label="Studio token" placeholder="Studio token" required><button type="submit">Open Studio</button></form></section>`,
  );
}

type QueueItem = { id: number; label: string; time: Date; kind: "post" | "video"; targets: number };
type AttentionItem = { id: number; label: string; kind: "post" | "video" };
type NotificationRow = { id: number; message: string; severity: string; createdAt: string };

function renderQueueTable(title: string, items: QueueItem[], zone: { timeZone: string; label: string }): string {
  if (!items.length) return `<h3>${title}</h3><p class="note">Empty.</p>`;
  const rows = items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.label)}</td><td>${item.kind}</td><td>${item.targets}</td><td class="nowrap">${escapeHtml(formatZonedDateTime(item.time, zone.timeZone, zone.label))}</td></tr>`,
    )
    .join("");
  return `<h3>${title}</h3><table><thead><tr><th>Label</th><th>Kind</th><th>Targets</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderAttention(items: AttentionItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item) => `<li>${item.kind === "video" ? "🎬" : "📝"} ${escapeHtml(item.label)}</li>`).join("");
  return `<h3>Needs attention</h3><ul class="attention-list">${rows}</ul>`;
}

function renderNotifications(events: NotificationRow[], zone: { timeZone: string; label: string }): string {
  if (!events.length) return '<p class="note">Inbox is empty.</p>';
  const rows = events
    .map(
      (event) =>
        `<li class="notification notification--${escapeHtml(event.severity)}"><span>${escapeHtml(event.message)}</span><time>${escapeHtml(formatZonedDateTime(event.createdAt, zone.timeZone, zone.label))}</time><form method="post" action="/studio/acknowledge"><input type="hidden" name="id" value="${event.id}"><button type="submit">Acknowledge</button></form></li>`,
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

function shell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Studio</title>
  <style>
    body { margin:0; padding:16px; background:#0d1117; color:#c9d1d9; font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { max-width:960px; margin:0 auto; }
    h1,h2,h3 { color:#fff; margin:0 0 8px; }
    h2 { margin-top:20px; }
    a { color:#58a6ff; }
    .studio-heading { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
    .studio-locale a { border:1px solid #30363d; border-radius:14px; padding:3px 9px; font-size:13px; text-decoration:none; margin-left:6px; }
    .studio-locale a.active { background:#1f6feb; border-color:#1f6feb; color:#fff; }
    section { border:1px solid #30363d; background:#161b22; border-radius:8px; padding:12px 14px; margin-top:12px; }
    .studio-analytics { white-space:normal; line-height:1.6; }
    .note { color:#8b949e; }
    table { width:100%; border-collapse:collapse; margin:6px 0 14px; }
    th,td { padding:6px 8px; border-bottom:1px solid #30363d; text-align:left; }
    th { color:#8b949e; font-weight:600; }
    .attention-list, .notification-list { list-style:none; margin:0; padding:0; }
    .attention-list li { padding:6px 0; border-bottom:1px solid #21262d; }
    .notification-list li { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #21262d; }
    .notification-list li:last-child { border-bottom:0; }
    .notification-list span { flex:1; }
    .notification-list time { color:#8b949e; font-size:12px; white-space:nowrap; }
    .notification--warn span, .notification--error span { color:#ff7b72; }
    form { display:inline; }
    input,button { background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:6px 10px; }
    button { cursor:pointer; }
    button:hover { border-color:#58a6ff; color:#58a6ff; }
    .studio-login { max-width:420px; margin:14vh auto; padding:24px; text-align:center; }
    .studio-login form { display:flex; flex-direction:column; gap:10px; margin-top:12px; }
    .login-error { color:#ff7b72; }
    .nowrap { white-space:nowrap; }
  </style>
</head>
<body>
<main>
  ${body}
</main>
</body>
</html>`;
}
