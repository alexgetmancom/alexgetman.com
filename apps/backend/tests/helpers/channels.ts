import type { UnsafeBackendDb } from "../../src/db/client.js";

const CHANNELS = {
  discord: ["discord", "en", "discord", "Discord EN"],
  instagram_en: ["instagram", "en", null, "Instagram EN"],
  instagram_ru: ["instagram", "ru", null, "Instagram RU"],
  instagram_stories: ["instagram_stories", "en", "instagram_stories", "Instagram Stories EN"],
  instagram_stories_ru: ["instagram_stories", "ru", "instagram_stories_ru", "Instagram Stories RU"],
  site_en: ["site", "en", "site_en", "Site EN"],
  site_ru: ["site", "ru", "site_ru", "Site RU"],
  telegram: ["telegram", "ru", "telegram", "Telegram RU"],
  telegram_stories: ["telegram_stories", "ru", "telegram_stories", "Telegram Stories RU"],
  threads_en: ["threads_en", "en", "threads_en", "Threads EN"],
  threads_ru: ["threads", "ru", "threads_ru", "Threads RU"],
  x: ["x", "en", "x", "X EN"],
  youtube_en: ["youtube", "en", null, "YouTube EN"],
  youtube_ru: ["youtube", "ru", null, "YouTube RU"],
} as const;

export type TestChannelId = keyof typeof CHANNELS;

/** A test names the real routes it needs; an empty test database stays empty. */
export function registerTestChannels(backendDb: UnsafeBackendDb, ids: readonly TestChannelId[]): void {
  const now = new Date(0).toISOString();
  for (const id of ids) {
    const [platform, locale, targetId, label] = CHANNELS[id];
    backendDb.channels.upsert(
      {
        id,
        platform,
        locale,
        provider: "native",
        providerAccountId: null,
        targetId,
        label,
        enabled: 1,
        source: "fixture",
      },
      now,
    );
  }
}

export const TEXT_TEST_CHANNELS = [
  "site_en",
  "site_ru",
  "telegram",
  "telegram_stories",
  "instagram_stories",
  "instagram_stories_ru",
  "threads_en",
  "threads_ru",
  "x",
  "discord",
] as const;

export const VIDEO_TEST_CHANNELS = ["instagram_en", "instagram_ru", "youtube_en", "youtube_ru"] as const;
