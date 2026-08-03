import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioActorId, StudioLocale } from "../contracts.js";
import { analyticsService } from "./analytics.js";
import { studioCapabilityService } from "./capabilities.js";
import { channelService } from "./channels.js";
import { studioDashboard } from "./dashboard.js";
import { mediaService } from "./media.js";
import { notificationService } from "./notifications.js";
import { postService } from "./posts.js";
import { publicationService } from "./publications.js";
import { queueService } from "./queue.js";
import { settingsService } from "./settings.js";
import { videoService } from "./videos.js";

/**
 * Single application entry point for every Studio interface.
 * Telegram, the future Web Studio and MCP receive the same capability set;
 * only rendering and transport live outside this boundary.
 */
export function studioServices(backendDb: BackendDb, config: BackendConfig) {
  const posts = postService(backendDb, config);
  const videos = videoService(backendDb, config);
  return {
    posts,
    publications: publicationService(posts, videos),
    media: mediaService(backendDb, config),
    channels: channelService(backendDb, config),
    videos,
    queue: queueService(backendDb, config),
    notifications: notificationService(backendDb, config),
    analytics: analyticsService(backendDb, config),
    capabilities: studioCapabilityService(config, backendDb),
    settings: settingsService(backendDb),
    dashboard: (actorId: StudioActorId, locale: StudioLocale) => studioDashboard(backendDb, config, actorId, locale),
  };
}

/** Explicit application contract shared by Telegram and MCP adapters. */
export type StudioServices = ReturnType<typeof studioServices>;
