import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";

export async function handleNotificationsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (
    data !== "notifications_home" &&
    data !== "notification_back" &&
    !data.startsWith("notification_ack:") &&
    !data.startsWith("notification_open:")
  )
    return false;
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
  const notifications = studioServices(backendDb, config).notifications;
  if (data.startsWith("notification_open:")) {
    const event = notifications.get(actorId, Number(data.slice("notification_open:".length)));
    await ctx.answerCallbackQuery();
    if (!event) return renderInbox(ctx, notifications.inbox(actorId, 10), locale);
    const keyboard = new InlineKeyboard()
      .text(ui(locale, "✓ Mark read", "✓ Прочитано"), `notification_ack:${event.id}`)
      .row()
      .text(ui(locale, "← Notifications", "← Уведомления"), "notification_back");
    await ctx.editMessageText(notificationText(event, locale), { reply_markup: keyboard });
    return true;
  }
  if (data.startsWith("notification_ack:")) notifications.acknowledge(actorId, Number(data.slice("notification_ack:".length)));
  await ctx.answerCallbackQuery();
  return renderInbox(ctx, notifications.inbox(actorId, 10), locale);
}

async function renderInbox(
  ctx: Context,
  events: ReturnType<ReturnType<typeof studioServices>["notifications"]["inbox"]>,
  locale: ReturnType<typeof botLocale>,
): Promise<boolean> {
  const lines = [`🔔 ${ui(locale, "Notifications", "Уведомления")}`];
  if (!events.length) lines.push(`\n${ui(locale, "No pending notifications.", "Новых уведомлений нет.")}`);
  const keyboard = new InlineKeyboard();
  for (const event of events) {
    keyboard.text(notificationLabel(event, locale), `notification_open:${event.id}`).text("✓", `notification_ack:${event.id}`).row();
  }
  keyboard.text(ui(locale, "⚙️ Notification settings", "⚙️ Настройки уведомлений"), "settings_notifications").row();
  keyboard.text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await ctx.editMessageText(lines.join("\n"), { reply_markup: keyboard });
  return true;
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
      ? ui(locale, "Error", "Ошибка")
      : event.severity === "warn"
        ? ui(locale, "Warning", "Предупреждение")
        : ui(locale, "Notification", "Уведомление");
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
