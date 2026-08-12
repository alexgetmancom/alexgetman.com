import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { syncCommunityProfiles, syncXProfile, syncZernioChannelProfile } from "../src/analytics/collection/profile-sync.js";
import { claimSync } from "../src/analytics/snapshots/creator-store.js";
import { registerChannel } from "../src/channels/registry.js";
import { analyticsSync, creatorProfileSnapshots, creatorProfiles } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { withDb } from "./helpers/db.js";

describe("creator profile sync boundary", () => {
  it("reclaims a crashed sync by lease age instead of refresh cadence", async () => {
    await withDb(async (backendDb) => {
      const source = "daily-profile";
      const intervalSeconds = 24 * 60 * 60;
      expect(claimSync(backendDb, source, { intervalSeconds, owner: "first-worker" })).toBe(true);
      expect(claimSync(backendDb, source, { intervalSeconds, owner: "second-worker" })).toBe(false);

      backendDb.db
        .update(analyticsSync)
        .set({ lockedAt: new Date(Date.now() - 16 * 60_000).toISOString() })
        .where(eq(analyticsSync.source, source))
        .run();

      expect(claimSync(backendDb, source, { intervalSeconds, owner: "second-worker" })).toBe(true);
      expect(backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, source)).get()?.lockedBy).toBe("second-worker");
    });
  });

  it("persists a Zernio channel profile and marks its owned sync successful", async () => {
    await withDb(async (backendDb) => {
      const connection = registerChannel(backendDb, {
        platform: "instagram",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "account-1",
      });
      const config = loadConfig({ ZERNIO_API_KEY: "a".repeat(16) });
      const fetchMock = (async () =>
        new Response(JSON.stringify([{ _id: "account-1", username: "marux_play", followersCount: 306 }]))) as unknown as typeof fetch;
      expect(
        claimSync(backendDb, connection.id, {
          intervalSeconds: config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS,
          owner: "profile-owner",
        }),
      ).toBe(true);

      await syncZernioChannelProfile(config, backendDb, fetchMock, connection, "profile-owner");

      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "instagram_ru")).get()?.dataJson).toMatchObject(
        {
          username: "marux_play",
          followersCount: 306,
        },
      );
      expect(backendDb.db.select().from(creatorProfileSnapshots).all()).toHaveLength(1);
      expect(backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, "instagram_ru")).get()).toMatchObject({
        lockedBy: null,
        lastError: null,
      });
    });
  });

  it("syncs X profile metrics through OAuth and keeps the account snapshot", async () => {
    await withDb(async (backendDb) => {
      const config = loadConfig({
        ENABLE_X_PROFILE_METRICS: "1",
        X_CONSUMER_KEY: "consumer",
        X_CONSUMER_SECRET: "secret",
        X_ACCESS_TOKEN: "access",
        X_ACCESS_TOKEN_SECRET: "access-secret",
      });
      const fetchMock = (async () =>
        new Response(
          JSON.stringify({
            data: {
              id: "x-user",
              name: "Alex",
              username: "alex",
              public_metrics: { followers_count: 120, following_count: 4, tweet_count: 87 },
            },
          }),
        )) as unknown as typeof fetch;

      expect(
        claimSync(backendDb, "x_profile", {
          intervalSeconds: config.CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS,
          owner: "x-owner",
        }),
      ).toBe(true);
      await syncXProfile(config, backendDb, fetchMock, "x-owner");

      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "x")).get()?.dataJson).toMatchObject({
        name: "Alex",
        followersCount: 120,
        postsCount: 87,
      });
      expect(backendDb.db.select().from(analyticsSync).where(eq(analyticsSync.source, "x_profile")).get()?.lastError).toBeNull();
    });
  });

  it("collects Telegram and Threads community profiles independently", async () => {
    await withDb(async (backendDb) => {
      const config = loadConfig({
        CONTROLLER_BOT_TOKEN: "bot-token",
        THREADS_RU_ACCESS_TOKEN: "threads-token",
        TELEGRAM_CHANNEL_USERNAME: "@alexchannel",
      });
      config.studio.modules.text_posting = true;
      const fetchMock = (async (input: URL | RequestInfo) => {
        const url = String(input);
        if (url.includes("getChatMemberCount")) return new Response(JSON.stringify({ ok: true, result: 512 }));
        if (url.includes("graph.threads.net")) return new Response(JSON.stringify({ id: "threads-user", username: "alex_threads" }));
        throw new Error(`Unexpected profile request: ${url}`);
      }) as unknown as typeof fetch;

      await syncCommunityProfiles(config, backendDb, fetchMock, "community-owner");

      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "telegram")).get()?.dataJson).toMatchObject({
        followersCount: 512,
      });
      expect(backendDb.db.select().from(creatorProfiles).where(eq(creatorProfiles.platform, "threads")).get()?.dataJson).toMatchObject({
        name: "alex_threads",
      });
      expect(
        backendDb.db
          .select()
          .from(analyticsSync)
          .all()
          .map((row) => row.source)
          .sort(),
      ).toEqual(["telegram_profile", "threads_profile"]);
    });
  });
});
