import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale as BotLocale } from "../locale.js";
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
