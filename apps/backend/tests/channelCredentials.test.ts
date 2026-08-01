import { describe, expect, it } from "bun:test";
import { channelConfig } from "../src/channels/channel-config.js";
import { channelSecrets, setChannelSecrets, storedCredentialNames } from "../src/channels/credentials.js";
import { videoDestinations } from "../src/channels/destinations.js";
import { registerChannel } from "../src/channels/registry.js";
import { channelCredentials } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { withDb } from "./helpers/db.js";

const SECRET_KEY = "fixture-channel-secret-key";

describe("channel credentials", () => {
  it("stores a channel's secrets encrypted and reads them back", async () => {
    await withDb((backendDb) => {
      setChannelSecrets(backendDb, SECRET_KEY, "youtube_en", { refreshToken: "1//real-refresh-token" });

      const rows = backendDb.db.select().from(channelCredentials).all();
      expect(rows).toHaveLength(1);
      // The column must never hold anything readable: a database backup is not
      // supposed to hand over a publishing account.
      expect(rows[0]?.valueEncrypted).not.toContain("real-refresh-token");
      expect(channelSecrets(backendDb, SECRET_KEY, "youtube_en")).toEqual({ refreshToken: "1//real-refresh-token" });
      expect(storedCredentialNames(backendDb, "youtube_en")).toEqual(["refreshToken"]);
    });
  });

  it("refuses to read a secret with the wrong key rather than returning rubbish", async () => {
    await withDb((backendDb) => {
      setChannelSecrets(backendDb, SECRET_KEY, "youtube_ru", { refreshToken: "token" });
      expect(() => channelSecrets(backendDb, "a-different-passphrase", "youtube_ru")).toThrow();
    });
  });

  it("lets a channel's own credentials stand in for the deployment's variables", async () => {
    await withDb((backendDb) => {
      const config = loadConfig({
        YOUTUBE_EN_CLIENT_ID: "en-client",
        YOUTUBE_EN_CLIENT_SECRET: "en-secret",
        YOUTUBE_EN_REFRESH_TOKEN: "from-environment",
        CHANNEL_SECRET_KEY: SECRET_KEY,
      });
      registerChannel(backendDb, { platform: "youtube", locale: "en", provider: "native", source: "cli" });
      setChannelSecrets(backendDb, SECRET_KEY, "youtube_en", { refreshToken: "from-channel" });

      expect(channelConfig(backendDb, config, "youtube", "en").YOUTUBE_EN_REFRESH_TOKEN).toBe("from-channel");
      // A locale with no channel of its own is untouched, so a Studio still
      // configured entirely through variables keeps working.
      expect(channelConfig(backendDb, config, "youtube", "ru").YOUTUBE_EN_REFRESH_TOKEN).toBe("from-environment");
    });
  });

  it("derives the destination catalogue from connected channels", async () => {
    await withDb((backendDb) => {
      // An empty registry falls back to the static catalogue, which is what
      // keeps fixtures and un-bootstrapped databases rendering.
      expect(videoDestinations(backendDb).map((destination) => destination.profile)).toEqual([
        "youtube_ru",
        "youtube_en",
        "instagram_ru",
        "instagram_en",
      ]);

      registerChannel(backendDb, { platform: "youtube", locale: "ru", provider: "native", label: "YouTube RU", source: "cli" });
      registerChannel(backendDb, { platform: "instagram", locale: "en", provider: "zernio", label: "Instagram EN", source: "cli" });

      expect(videoDestinations(backendDb)).toEqual([
        { target: "instagram_reels", locale: "en", label: "Instagram EN", profile: "instagram_en" },
        { target: "youtube_shorts", locale: "ru", label: "YouTube RU", profile: "youtube_ru" },
      ]);
    });
  });
});
