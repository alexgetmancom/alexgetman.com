import { Menu } from "@grammyjs/menu";
import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { showAnalyticsDashboard } from "./analytics-screen.js";
import { openPostScreen } from "./post-screen.js";
import { showQueue } from "./queue.js";
import { SETTINGS_MENU_ID } from "./settings-screen.js";
import { startVideoConversation } from "./video-conversation.js";

const MAIN_MENU_ID = "main-menu";

export function buildMainMenu(
  config: BackendConfig,
  backendDb: BackendDb,
  settingsMenu: Menu<Context>,
  notificationsMenu: Menu<Context>,
): Menu<Context> {
  const menu = new Menu<Context>(MAIN_MENU_ID);
  // Creation is the primary action and deliberately gets its own full row, so
  // post and video creation both stay obvious.
  menu
    .text(
      (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.new-post"),
      (ctx) => openPostScreen(ctx, backendDb),
    )
    .row();
  menu
    .text(
      (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.new-video"),
      (ctx) => startVideoConversation(ctx, backendDb),
    )
    .row();
  menu.text(
    (ctx) => {
      const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
      const queue = createStudioServices(backendDb, config).queue.snapshot(Number(ctx.from?.id));
      const pending = queue.upcoming.length + queue.drafts.length;
      return pending ? t(locale, "menu.work-queue-count", { count: pending }) : t(locale, "menu.work-queue");
    },
    (ctx) => showQueue(ctx, backendDb, config),
  );
  menu.text(
    (ctx) => t(settingsService(backendDb).locale(Number(ctx.from?.id)), "menu.analytics"),
    (ctx) => showAnalyticsDashboard(ctx, backendDb, config, "overview", 1),
  );
  menu.submenu(
    (ctx) => {
      const locale = settingsService(backendDb).locale(Number(ctx.from?.id));
      const unread = createStudioServices(backendDb, config).notifications.inbox(Number(ctx.from?.id), 100).length;
      return unread ? t(locale, "menu.settings-unread", { count: unread }) : t(locale, "settings.title");
    },
    SETTINGS_MENU_ID,
    async (ctx) => {
      await ctx.editMessageText(t(settingsService(backendDb).locale(Number(ctx.from?.id)), "settings.title"));
    },
  );
  menu.register(settingsMenu);
  menu.register(notificationsMenu);
  return menu;
}
