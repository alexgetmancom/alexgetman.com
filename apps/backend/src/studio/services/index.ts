import { importStudioMediaAsset } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import type { StudioActorId, StudioEntityContract, StudioLocale } from "../contracts.js";
import { analyticsService } from "./analytics.js";
import { studioCapabilityService } from "./capabilities.js";
import { studioDashboard } from "./dashboard.js";
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
  const posts = postService(backendDb);
  const videos = videoService(backendDb, config);
  assertEntityContract(posts);
  assertEntityContract(videos);
  return {
    posts,
    publications: publicationService(backendDb, config),
    media: {
      import: (actorId: StudioActorId, input: Parameters<typeof importStudioMediaAsset>[3]) =>
        importStudioMediaAsset(backendDb, config, actorId, input),
    },
    videos,
    queue: queueService(backendDb),
    notifications: notificationService(backendDb),
    analytics: analyticsService(backendDb, config),
    capabilities: studioCapabilityService(config),
    settings: settingsService(backendDb),
    dashboard: (actorId: StudioActorId, locale: StudioLocale) => studioDashboard(backendDb, config, actorId, locale),
  };
}

/** Compile-time guard: every Studio entity exposes the same transport-neutral verbs. */
function assertEntityContract(_service: StudioEntityContract<number, never, never, never, unknown, unknown, unknown>): void {}

/** Explicit application contract shared by Telegram and MCP adapters. */
export type StudioServices = ReturnType<typeof studioServices>;
