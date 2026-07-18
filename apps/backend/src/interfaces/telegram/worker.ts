import type { Bot } from "grammy";
import { finalizePendingAlbums } from "../../bot/albums.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import { type ScheduledLoop, startLoop } from "../../foundation/scheduler.js";
import { deliverPendingAlerts } from "../../observability/alerts.js";
import { sendWeeklyAnalyticsSummary } from "./analytics-summary.js";
import { consumeTelegramEvents } from "./event-consumer.js";

/** Telegram is an event consumer and ingress adapter, never a domain worker dependency. */
export function startTelegramWorkers(config: BackendConfig, backendDb: BackendDb, bot: Bot | null): ScheduledLoop[] {
  if (!config.ENABLE_WORKERS || !bot) return [];
  return [
    startLoop("telegram-albums", 1000, async () => {
      const completed = await finalizePendingAlbums(bot, backendDb, config);
      if (completed) log("info", "album drafts finalized", { completed });
    }),
    startLoop("telegram-events", config.IDLE_POLL_INTERVAL_SECONDS * 1000, async () => {
      const events = await consumeTelegramEvents(backendDb, bot, config);
      const adminId = config.ADMIN_IDS[0];
      const alerts = await deliverPendingAlerts(config, backendDb, {
        ...(adminId === undefined ? {} : { sendAlert: async (text) => void (await bot.api.sendMessage(adminId, text)) }),
      });
      const weeklySummary = await sendWeeklyAnalyticsSummary(config, backendDb, bot);
      log("debug", "telegram interface loop tick", { events, alerts, weeklySummary });
    }),
  ];
}
