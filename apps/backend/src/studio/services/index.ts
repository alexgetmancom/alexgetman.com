import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioActorId, StudioLocale } from "../contracts.js";
import { analyticsService } from "./analytics.js";
import { studioDashboard } from "./dashboard.js";
import { notificationService } from "./notifications.js";
import { postService } from "./posts.js";
import { queueService } from "./queue.js";
import { settingsService } from "./settings.js";
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
    settings: settingsService(backendDb),
    dashboard: (actorId: StudioActorId, locale: StudioLocale) => studioDashboard(backendDb, config, actorId, locale),
  };
}

/** Explicit application contract shared by Telegram and MCP adapters. */
export type StudioServices = ReturnType<typeof studioServices>;
