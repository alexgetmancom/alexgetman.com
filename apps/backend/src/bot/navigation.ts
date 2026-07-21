import { Menu } from "@grammyjs/menu";
import { type Context, Keyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { studioServices } from "../studio/services/index.js";
import { defaultAnalyticsSection, showAnalyticsDashboard } from "./analytics-screen.js";
import { type BotLocale, botLocale } from "./i18n.js";
import { openPostScreen } from "./post-screen.js";
import { showQueue } from "./queue.js";
import { SETTINGS_MENU_ID } from "./settings-screen.js";
import { startVideoConversation } from "./video-conversation.js";

const MAIN_MENU_ID = "main-menu";

export function persistentKeyboard(locale: BotLocale = "en"): Keyboard {
  return new Keyboard().text(t(locale, "menu.button")).resized().persistent();
}

export function buildMainMenu(
  config: BackendConfig,
  backendDb: BackendDb,
  settingsMenu: Menu<Context>,
  notificationsMenu: Menu<Context>,
): Menu<Context> {
  const menu = new Menu<Context>(MAIN_MENU_ID);
  // Creation is the primary action and deliberately gets its own full row.
  // A video-only Studio (such as Maru) therefore has the compact two-row
  // layout, while a mixed Studio still keeps post and video creation obvious.
  if (config.studio.modules.text_posting)
    menu
      .text(
        (ctx) => t(botLocale(backendDb, Number(ctx.from?.id)), "menu.new-post"),
        (ctx) => openPostScreen(ctx, backendDb),
      )
      .row();
  if (config.studio.modules.video_posting)
    menu
      .text(
        (ctx) => t(botLocale(backendDb, Number(ctx.from?.id)), "menu.new-video"),
        (ctx) => startVideoConversation(ctx, backendDb),
      )
      .row();
  menu.text(
    (ctx) => {
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      const queue = studioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
      const pending = queue.upcoming.length + queue.drafts.length;
      return pending ? t(locale, "menu.work-queue-count", { count: pending }) : t(locale, "menu.work-queue");
    },
    (ctx) => showQueue(ctx, backendDb, config),
  );
  if (config.studio.modules.analytics)
    menu.text(
      (ctx) => t(botLocale(backendDb, Number(ctx.from?.id)), "menu.analytics"),
      (ctx) => showAnalyticsDashboard(ctx, backendDb, config, defaultAnalyticsSection(config), 1),
    );
  menu.submenu(
    (ctx) => {
      const locale = botLocale(backendDb, Number(ctx.from?.id));
      const unread = studioServices(backendDb, config).notifications.inbox(Number(ctx.from?.id), 100).length;
      return unread ? t(locale, "menu.settings-unread", { count: unread }) : t(locale, "settings.title");
    },
    SETTINGS_MENU_ID,
    async (ctx) => {
      await ctx.editMessageText(t(botLocale(backendDb, Number(ctx.from?.id)), "settings.title"));
    },
  );
  menu.register(settingsMenu);
  menu.register(notificationsMenu);
  return menu;
}

export async function showMainMenu(ctx: Context, backendDb: BackendDb, mainMenu: Menu<Context>, edit = false): Promise<void> {
  const locale = botLocale(backendDb, Number(ctx.from?.id));
  // Telegram does not allow a message consisting only of an inline keyboard.
  // This is deliberately a neutral heading, not a noisy "all clear" status.
  const text = t(locale, "menu.control-panel");
  const options = { reply_markup: mainMenu };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}
