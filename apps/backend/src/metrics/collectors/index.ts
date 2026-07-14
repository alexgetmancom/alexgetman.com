import type { BackendConfig } from "../../config.js";
import type { MetricTask } from "../schedule.js";
import { collectBluesky, collectDevto, collectGitHub, collectMastodon } from "./community.js";
import { collectLinkedIn } from "./linkedin.js";
import { collectFacebook, collectInstagramStory } from "./meta.js";
import { collectTelegram, collectTelegramStory } from "./telegram.js";
import { collectThreads } from "./threads.js";
import type { MetricCollector } from "./types.js";
import { collectX } from "./x.js";

export function createMetricCollectors(config: BackendConfig, fetchImpl: typeof fetch = fetch): Record<string, MetricCollector> {
  const threads = (task: MetricTask) => collectThreads(task, config, fetchImpl);
  const facebook = (task: MetricTask) => collectFacebook(task, config, fetchImpl);
  const instagram = (task: MetricTask) => collectInstagramStory(task, config, fetchImpl);
  const collectors: Record<string, MetricCollector> = {
    telegram: (task) => collectTelegram(task, config, fetchImpl),
    threads,
    threads_ru: threads,
    threads_en: threads,
    facebook,
    facebook_ru: facebook,
    devto: (task) => collectDevto(task, config, fetchImpl),
    bluesky: (task) => collectBluesky(task, fetchImpl),
    mastodon: (task) => collectMastodon(task, config, fetchImpl),
    github: (task) => collectGitHub(task, config, fetchImpl),
    github_en: (task) => collectGitHub(task, config, fetchImpl),
    github_ru: (task) => collectGitHub(task, config, fetchImpl),
    instagram_story: instagram,
    instagram_stories: instagram,
    instagram_stories_ru: instagram,
    telegram_story: (task) => collectTelegramStory(task, config),
    telegram_stories: (task) => collectTelegramStory(task, config),
  };
  if (config.ENABLE_LINKEDIN_METRICS) collectors.linkedin = (task) => collectLinkedIn(task, config, fetchImpl);
  if (config.ENABLE_X_METRICS) {
    collectors.x = (task) => collectX(task, config, fetchImpl);
    collectors.twitter = (task) => collectX(task, config, fetchImpl);
  }
  return collectors;
}
