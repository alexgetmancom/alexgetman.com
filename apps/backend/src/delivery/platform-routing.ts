import { TARGET_GROUPS } from "../botTargets.js";
import type { BackendConfig } from "../foundation/config.js";
import { instagramConfigForLocale } from "../foundation/external/instagram.js";

/** Resolves the configuration seen by one durable delivery target. */
export function platformConfig(target: string, config: BackendConfig): BackendConfig {
  if (target === "threads_en") return { ...config, THREADS_ACCESS_TOKEN: config.THREADS_EN_ACCESS_TOKEN ?? config.THREADS_ACCESS_TOKEN };
  // Stories carry the shared fallback for English; Reels deliberately do not.
  if (target === "instagram_stories" || target === "instagram_stories_ru") {
    const locale = target === "instagram_stories" ? "en" : "ru";
    const normalized = instagramConfigForLocale(config, locale, "shared");
    const credentials = { accessToken: normalized.INSTAGRAM_ACCESS_TOKEN, userId: normalized.INSTAGRAM_USER_ID };
    return {
      ...normalized,
      ...(locale === "en"
        ? { INSTAGRAM_EN_ACCESS_TOKEN: credentials.accessToken, INSTAGRAM_EN_USER_ID: credentials.userId }
        : { INSTAGRAM_RU_ACCESS_TOKEN: credentials.accessToken, INSTAGRAM_RU_USER_ID: credentials.userId }),
    };
  }
  return config;
}

/** Builds the immutable target-to-config routing table for one worker instance. */
export function platformTargetConfigs(config: BackendConfig): Record<string, BackendConfig> {
  const threadsEnConfig = platformConfig("threads_en", config);
  const instagramEnConfig = platformConfig("instagram_stories", config);
  const instagramRuConfig = platformConfig("instagram_stories_ru", config);
  return {
    telegram: config,
    ...Object.fromEntries(TARGET_GROUPS.threads.map((target) => [target, target === "threads_en" ? threadsEnConfig : config])),
    ...Object.fromEntries(TARGET_GROUPS.x.map((target) => [target, config])),
    ...Object.fromEntries(
      TARGET_GROUPS.instagramStory.map((target) => [
        target,
        target === "instagram_stories" ? instagramEnConfig : target === "instagram_stories_ru" ? instagramRuConfig : config,
      ]),
    ),
    ...Object.fromEntries(TARGET_GROUPS.telegramStory.map((target) => [target, config])),
  };
}
