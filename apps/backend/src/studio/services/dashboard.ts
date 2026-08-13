import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { analyticsService } from "./analytics.js";
import { queueService } from "./queue.js";

/** Read model for Web Studio, Command Center and MCP. */
export function studioDashboard(backendDb: BackendDb, config: BackendConfig, actorId: number, locale: StudioLocale) {
  return {
    queue: queueService(backendDb, config).snapshot(actorId),
    analytics: analyticsService(backendDb, config).dashboard("overview", 7, locale),
  };
}
