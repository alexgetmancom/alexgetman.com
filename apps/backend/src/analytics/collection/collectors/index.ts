import type { BackendConfig } from "../../../foundation/config.js";
import type { MetricTask } from "../metric-schedule.js";
import { collectInstagramStory } from "./meta.js";
import { collectTelegram, collectTelegramStory } from "./telegram.js";
import { collectThreads } from "./threads.js";
import type { MetricCollector } from "./types.js";
import { collectX } from "./x.js";

/**
 * Every target this build knows how to collect, including the paid ones and the legacy
 * aliases still present in durable schedules. Deliberately static: `createMetricCollectors`
 * drops targets when a flag or credential is absent, and callers that retire schedules must
 * not confuse "off right now" with "gone from the product".
 */
export const SUPPORTED_METRIC_TARGETS = [
  "telegram",
  "threads",
  "threads_ru",
  "threads_en",
  "instagram_story",
  "instagram_stories",
  "instagram_stories_ru",
  "telegram_story",
  "telegram_stories",
  "x",
  "twitter",
] as const;

export function createMetricCollectors(config: BackendConfig, fetchImpl: typeof fetch = fetch): Record<string, MetricCollector> {
  const threads = (task: MetricTask) => collectThreads(task, config, fetchImpl);
  const instagram = (task: MetricTask) => collectInstagramStory(task, config, fetchImpl);
  const collectors: Record<string, MetricCollector> = {
    telegram: (task) => collectTelegram(task, config, fetchImpl),
    threads,
    threads_ru: threads,
    threads_en: threads,
    instagram_story: instagram,
    instagram_stories: instagram,
    instagram_stories_ru: instagram,
    telegram_story: (task) => collectTelegramStory(task, config),
    telegram_stories: (task) => collectTelegramStory(task, config),
  };
  if (config.ENABLE_X_METRICS) {
    collectors.x = (task) => collectX(task, config, fetchImpl);
    collectors.twitter = (task) => collectX(task, config, fetchImpl);
  }
  return collectors;
}
