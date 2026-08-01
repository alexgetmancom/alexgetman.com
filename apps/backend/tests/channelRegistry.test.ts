import { describe, expect, it } from "bun:test";
import {
  bootstrapConfiguredChannels,
  channelForVideo,
  configuredChannels,
  listChannels,
  registerChannel,
} from "../src/channels/registry.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { publishJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { withDb } from "./helpers/db.js";

describe("channel registry", () => {
  it("discovers native Instagram accounts independently for RU and EN video drafts", () => {
    const config = loadConfig({
      INSTAGRAM_ACCESS_TOKEN: "shared-token",
      INSTAGRAM_USER_ID: "shared-user",
      INSTAGRAM_RU_ACCESS_TOKEN: "ru-token",
      INSTAGRAM_RU_USER_ID: "ru-user",
      INSTAGRAM_EN_ACCESS_TOKEN: "en-token",
      INSTAGRAM_EN_USER_ID: "en-user",
    });
    config.studio.modules.video_posting = true;
    config.studio.modules.instagram = true;

    expect(configuredChannels(config).filter((channel) => channel.platform === "instagram")).toEqual([
      expect.objectContaining({ id: "instagram_ru", locale: "ru", provider: "native", providerAccountId: "ru-user" }),
      expect.objectContaining({ id: "instagram_en", locale: "en", provider: "native", providerAccountId: "en-user" }),
    ]);
  });

  it("discovers independent configured locale routes", () => {
    const config = loadConfig({
      STUDIO_CONFIG: "studio.yaml",
      YOUTUBE_CLIENT_ID: "ru-id",
      YOUTUBE_CLIENT_SECRET: "ru-secret",
      YOUTUBE_REFRESH_TOKEN: "ru-token",
      YOUTUBE_EN_CLIENT_ID: "en-id",
      YOUTUBE_EN_CLIENT_SECRET: "en-secret",
      YOUTUBE_EN_REFRESH_TOKEN: "en-token",
      ZERNIO_API_KEY: "0000000000000000",
      PUBLISH_PROVIDER_ROUTES_JSON: JSON.stringify({
        instagram_reels: { provider: "zernio", accountId: "ig-ru" },
        instagram_reels_en: { provider: "zernio", accountId: "ig-en" },
      }),
    });
    config.studio.modules.text_posting = false;
    config.studio.modules.youtube = true;
    config.studio.modules.instagram = true;
    expect(configuredChannels(config).map((channel) => channel.id)).toEqual(["youtube_ru", "youtube_en", "instagram_ru", "instagram_en"]);
  });

  it("uses an interface-added account as the publication route", () =>
    withDb((backendDb) => {
      registerChannel(backendDb, {
        platform: "instagram",
        locale: "en",
        provider: "zernio",
        providerAccountId: "new-account",
      });
      expect(channelForVideo(backendDb, "instagram_reels", "en")?.providerAccountId).toBe("new-account");
    }));

  it("does not overwrite an interface selection during configuration bootstrap", () =>
    withDb((backendDb) => {
      const config = loadConfig({
        ZERNIO_API_KEY: "0000000000000000",
        PUBLISH_PROVIDER_ROUTES_JSON: JSON.stringify({
          instagram_reels_en: { provider: "zernio", accountId: "configured-account" },
        }),
      });
      config.studio.modules.instagram = true;
      registerChannel(backendDb, {
        platform: "instagram",
        locale: "en",
        provider: "zernio",
        providerAccountId: "selected-account",
      });
      bootstrapConfiguredChannels(backendDb, config);
      expect(channelForVideo(backendDb, "instagram_reels", "en")?.providerAccountId).toBe("selected-account");
    }));

  it("bootstraps text channels and creates jobs only for registered targets", () =>
    withDb((backendDb) => {
      const config = loadConfig({
        CONTROLLER_BOT_TOKEN: "controller-token",
        THREADS_ACCESS_TOKEN: "threads-token",
      });
      config.studio.modules.text_posting = true;
      config.studio.modules.site = true;
      bootstrapConfiguredChannels(backendDb, config);
      expect(
        listChannels(backendDb)
          .map((channel) => channel.targetId)
          .filter(Boolean),
      ).toEqual(["site_en", "site_ru", "telegram", "threads_ru"]);

      const draftId = createDraftFromMessage(backendDb, 1, { text: "Registered targets", entities: [], media: [] });
      publishDraftToQueue(backendDb, draftId);
      expect(
        backendDb.db
          .select({ target: publishJobs.target })
          .from(publishJobs)
          .all()
          .map((row) => row.target)
          .sort(),
      ).toEqual(["telegram", "threads_ru"]);
    }));

  it("does not validate a disconnected platform", () =>
    withDb((backendDb) => {
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "controller-token" });
      config.studio.modules.text_posting = true;
      config.studio.modules.site = false;
      bootstrapConfiguredChannels(backendDb, config);
      const draftId = createDraftFromMessage(backendDb, 1, { text: "x".repeat(600), entities: [], media: [] });
      expect(() => publishDraftToQueue(backendDb, draftId)).not.toThrow();
      expect(backendDb.db.select({ target: publishJobs.target }).from(publishJobs).all()).toEqual([{ target: "telegram" }]);
    }));
});
