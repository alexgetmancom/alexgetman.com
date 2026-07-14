import type { BotLocale } from "../../bot/i18n.js";
import type { BackendConfig } from "../../config.js";
import type { BackendDb } from "../../db/client.js";
import { analyticsService } from "./analytics.js";
import { notificationService } from "./notifications.js";
import { queueService } from "./queue.js";

/** Read model for Web Studio, Command Center and MCP. */
export function studioDashboard(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: BotLocale) {
  return {
    queue: queueService(backendDb).snapshot(actorId),
    notifications: notificationService(backendDb).inbox(actorId, 20),
    analytics: analyticsService(backendDb, config).dashboard("overview", 7, locale),
  };
}
