import { TARGET_GROUPS } from "../botTargets.js";
import type { BackendConfig } from "../foundation/config.js";

/** Resolves the configuration seen by one durable delivery target. */
export function platformConfig(target: string, config: BackendConfig): BackendConfig {
  if (target === "threads_en") return { ...config, THREADS_ACCESS_TOKEN: config.THREADS_EN_ACCESS_TOKEN ?? config.THREADS_ACCESS_TOKEN };
  return config;
}

/** Builds the immutable target-to-config routing table for one worker instance. */
export function platformTargetConfigs(config: BackendConfig): Record<string, BackendConfig> {
  const threadsEnConfig = platformConfig("threads_en", config);
  return {
    telegram: config,
    ...Object.fromEntries(TARGET_GROUPS.threads.map((target) => [target, target === "threads_en" ? threadsEnConfig : config])),
    ...Object.fromEntries(TARGET_GROUPS.x.map((target) => [target, config])),
    ...Object.fromEntries(TARGET_GROUPS.instagramStory.map((target) => [target, config])),
    ...Object.fromEntries(TARGET_GROUPS.telegramStory.map((target) => [target, config])),
  };
}
