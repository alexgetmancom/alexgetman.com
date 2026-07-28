import { describe, expect, it } from "bun:test";
import { bootstrapConfiguredChannels, channelForVideo, configuredChannels, registerChannel } from "../src/channels/registry.js";
import { loadConfig } from "../src/foundation/config.js";
import { withDb } from "./helpers/db.js";

describe("channel registry", () => {
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
});
