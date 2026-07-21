import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale } from "./i18n.js";

export const NOTIFICATIONS_MENU_ID = "notifications-menu";

export function buildNotificationsMenu(config: BackendConfig, backendDb: BackendDb): Menu<Context> {
  const detail = new Menu<Context>("notification-detail", { autoAnswer: true }).dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = botLocale(backendDb, actorId);
    const notifications = studioServices(backendDb, config).notifications;
    const event = notifications.get(actorId, Number(ctx.match));
    if (!event) {
      range.back(t(locale, "notif.back"));
      return;
    }
    range
      .text({ text: t(locale, "notif.mark-read"), payload: String(event.id) }, async (ctx) => {
        notifications.acknowledge(actorId, Number(ctx.match));
        ctx.menu.nav(NOTIFICATIONS_MENU_ID);
        await ctx.editMessageText(notificationsInboxText(backendDb, config, actorId, locale));
      })
      .row()
      .back(t(locale, "notif.back"));
  });

  const inbox = new Menu<Context>(NOTIFICATIONS_MENU_ID, { autoAnswer: true });
  inbox.dynamic((ctx, range) => {
    const actorId = Number(ctx.from?.id);
    const locale = botLocale(backendDb, actorId);
    const events = studioServices(backendDb, config).notifications.inbox(actorId, 10);
    for (const event of events) {
      range
        .submenu({ text: notificationLabel(event, locale), payload: String(event.id) }, "notification-detail", async (ctx) => {
          const found = studioServices(backendDb, config).notifications.get(actorId, Number(ctx.match));
          if (found) await ctx.editMessageText(notificationText(found, locale));
        })
        .text({ text: "✓", payload: String(event.id) }, async (ctx) => {
          studioServices(backendDb, config).notifications.acknowledge(actorId, Number(ctx.match));
          await ctx.editMessageText(notificationsInboxText(backendDb, config, actorId, locale));
        })
        .row();
    }
    range.back(t(locale, "common.menu"));
  });
  inbox.register(detail);
  return inbox;
}

export function notificationsInboxText(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  locale: ReturnType<typeof botLocale>,
): string {
  const events = studioServices(backendDb, config).notifications.inbox(actorId, 10);
  const lines = [`🔔 ${t(locale, "notif.title")}`];
  if (!events.length) lines.push(`\n${t(locale, "notif.none")}`);
  return lines.join("\n");
}

function notificationLabel(
  event: { severity: string; target: string | null; eventType: string; message: string },
  locale: ReturnType<typeof botLocale>,
): string {
  const prefix = event.severity === "error" ? "🔴" : event.severity === "warn" ? "🟡" : "🔔";
  const text = event.message || event.target || event.eventType;
  return `${prefix} ${text}`.replace(/\s+/g, " ").slice(0, locale === "ru" ? 48 : 52);
}

function notificationText(
  event: { severity: string; target: string | null; eventType: string; message: string; postKey: string | null; createdAt: string },
  locale: ReturnType<typeof botLocale>,
): string {
  const status =
    event.severity === "error"
      ? t(locale, "notif.status-error")
      : event.severity === "warn"
        ? t(locale, "notif.status-warning")
        : t(locale, "notif.status-notification");
  return [
    `${event.severity === "error" ? "🔴" : event.severity === "warn" ? "🟡" : "🔔"} ${status}`,
    "",
    event.message,
    event.target ? `Target: ${event.target}` : "",
    event.postKey ? `Ref: ${event.postKey}` : "",
    new Date(event.createdAt).toLocaleString(locale === "ru" ? "ru-RU" : "en-GB", { timeZone: "Europe/Moscow" }),
  ]
    .filter(Boolean)
    .join("\n");
}
