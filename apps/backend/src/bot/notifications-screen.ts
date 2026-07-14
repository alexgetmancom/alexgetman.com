import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { studioServices } from "../studio/services/index.js";
import { botLocale, ui } from "./i18n.js";

export async function handleNotificationsCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (data !== "notifications_home" && !data.startsWith("notification_ack:")) return false;
  const actorId = Number(ctx.from?.id);
  if (data.startsWith("notification_ack:")) studioServices(backendDb, config).notifications.acknowledge(actorId, Number(data.slice(17)));
  const locale = botLocale(backendDb, actorId);
  const events = studioServices(backendDb, config).notifications.inbox(actorId, 10);
  const lines = [`🔔 *${ui(locale, "Notifications", "Уведомления")}*`];
  if (!events.length) lines.push(`\n${ui(locale, "No pending notifications.", "Новых уведомлений нет.")}`);
  const keyboard = new InlineKeyboard();
  for (const event of events) {
    lines.push(`\n${event.severity === "error" ? "🔴" : "🟡"} *${event.target ?? event.eventType}*\n${event.message}`);
    keyboard.text(ui(locale, "✓ Mark read", "✓ Прочитано"), `notification_ack:${event.id}`).row();
  }
  keyboard.text(ui(locale, "← Menu", "← Меню"), "menu_home");
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(lines.join("\n").slice(0, 3900), { parse_mode: "Markdown", reply_markup: keyboard });
  return true;
}
