import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/foundation/config.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("Studio service boundaries", () => {
  it("reuses the service bundle for one database and configuration", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({});
      expect(createStudioServices(backendDb, config)).toBe(createStudioServices(backendDb, config));
    } finally {
      backendDb.close();
    }
  });

  it("imports byte and file media through one facade with content deduplication", async () => {
    const backendDb = openBackendDb(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-service-media-"));
    try {
      const config = loadConfig({ STUDIO_MEDIA_DIR: directory, STUDIO_MEDIA_MAX_BYTES: "1000" });
      const media = createStudioServices(backendDb, config).media;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const first = await media.import(42, {
        filename: "first.jpg",
        contentType: "image/jpeg",
        bytes,
        source: "mcp_upload",
      });
      const source = path.join(directory, "incoming.jpg");
      fs.writeFileSync(source, bytes);
      const second = await media.importFile(42, {
        filename: "second.png",
        contentType: "image/png",
        localPath: source,
        source: "http_upload",
      });

      expect(second.id).toBe(first.id);
      expect(second.localPath).toBe(first.localPath);
    } finally {
      backendDb.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps locale and YouTube signature in the shared settings service", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const settings = createStudioServices(backendDb, loadConfig({})).settings;
      expect(settings.locale(42)).toBe("en");
      settings.setLocale(42, "ru");
      expect(settings.locale(42)).toBe("ru");
      settings.setTimezone(42, "America/New_York");
      expect(settings.timezone(42, "Europe/Moscow")).toBe("America/New_York");
      expect(settings.timeConfig(42, { TIMEZONE: "Europe/Moscow", TIMEZONE_LABEL: "MSK" })).toMatchObject({
        TIMEZONE: "America/New_York",
      });
      settings.setYoutubeSignature(42, "https://example.com\\path");
      expect(settings.youtubeSignature(42)).toBe("https://example.com/path");
      settings.clearYoutubeSignature(42);
      expect(settings.youtubeSignature(42)).toBe("");
    } finally {
      backendDb.close();
    }
  });

  it("connects channels through the shared channel service without exposing credentials", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ CHANNEL_SECRET_KEY: "channel-secret-16" });
      const channels = createStudioServices(backendDb, config).channels;
      const result = channels.connect({
        platform: "instagram",
        locale: "en",
        provider: "native",
        accountId: "account-1",
        credentials: { accessToken: "secret-token", userId: "account-1" },
      });
      expect(result.channel.source).toBe("interface");
      expect(result.stored).toEqual(["accessToken", "userId"]);
      expect(channels.list()).toMatchObject([{ id: "instagram_en", providerAccountId: "account-1" }]);
      expect(JSON.stringify(channels.list())).not.toContain("secret-token");
    } finally {
      backendDb.close();
    }
  });

  it("keeps every analytics operation behind the shared Studio boundary", async () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const analytics = createStudioServices(backendDb, loadConfig({})).analytics;

      expect(analytics.postArchive(0, "en").total).toBe(0);
      expect(typeof analytics.postMetrics(999, "en")).toBe("string");
      expect(analytics.postMedia(999, "en")).toEqual([]);
      expect(analytics.archiveSummary("en").posts).toBe(0);
      expect(analytics.videoArchive(0, "en").total).toBe(0);
      expect(typeof analytics.videoMetrics(999, "en")).toBe("string");
      expect(await analytics.audienceAnalysis("en")).toContain("🤖");
    } finally {
      backendDb.close();
    }
  });
});
