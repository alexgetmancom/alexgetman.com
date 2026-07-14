import type { BackendConfig } from "../../config.js";
import type { BackendDb } from "../../db/client.js";
import { analyticsService } from "./analytics.js";
import { studioDashboard } from "./dashboard.js";
import { notificationService } from "./notifications.js";
import { postService } from "./posts.js";
import { queueService } from "./queue.js";
import { videoService } from "./videos.js";

/**
 * Single application entry point for every Studio interface.
 * Telegram, the future Web Studio and MCP receive the same capability set;
 * only rendering and transport live outside this boundary.
 */
export function studioServices(backendDb: BackendDb, config: BackendConfig) {
  return {
    posts: postService(backendDb),
    videos: videoService(backendDb, config),
    queue: queueService(backendDb),
    notifications: notificationService(backendDb),
    analytics: analyticsService(backendDb, config),
    dashboard: (actorId: number, locale: "en" | "ru") => studioDashboard(backendDb, config, actorId, locale),
  };
}
