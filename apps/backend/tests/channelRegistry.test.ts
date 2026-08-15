import { describe, expect, it } from "bun:test";
import { channelForVideo, listChannels, registerChannel, registeredPostTargetIds, targetRouting } from "../src/channels/registry.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { channelConnections, publishJobs } from "../src/db/schema.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { withDb } from "./helpers/db.js";

describe("channel registry", () => {
  it("refuses a platform that could never publish or be collected", () =>
    withDb((backendDb) => {
      // The registry used to take any string. The row it created had no
      // delivery target and no credential requirements, so the readiness report
      // asked what it needed, was told nothing, and called it ready.
      expect(() => registerChannel(backendDb, { platform: "nonsense", locale: "ru", provider: "native" })).toThrow("Unknown platform");
      expect(listChannels(backendDb, false)).toHaveLength(0);

      // TikTok is never published to natively, but it is a real account this
      // Studio collects from through a provider.
      expect(registerChannel(backendDb, { platform: "tiktok", locale: "ru", provider: "zernio" }).id).toBe("tiktok_ru");
      // A text channel names its target instead of a video platform.
      expect(registerChannel(backendDb, { platform: "telegram", locale: "ru", provider: "native", targetId: "telegram" }).id).toBe(
        "telegram",
      );
    }));

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

  it("serves the Story target from the Instagram account, whichever way it is delivered", () =>
    withDb((backendDb) => {
      backendDb.db.delete(channelConnections).run();
      registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "zernio", providerAccountId: "maru-account" });
      registerChannel(backendDb, { platform: "instagram", locale: "en", provider: "native" });

      // One account, both of the things it publishes: connecting Instagram used
      // to leave Stories unconnected, and a Studio reaching Instagram only
      // through the provider had no way to connect them at all.
      expect(registeredPostTargetIds(backendDb)).toEqual(new Set(["instagram_stories_ru", "instagram_stories"]));
      expect(targetRouting(backendDb).instagram_stories_ru).toEqual({ provider: "zernio", accountId: "maru-account" });
      expect(targetRouting(backendDb).instagram_stories).toEqual({ provider: "native", accountId: null });
      expect(channelForVideo(backendDb, "instagram_reels", "ru")?.providerAccountId).toBe("maru-account");

      // And the account is the only place it can be connected: a second row for
      // the Story is the same account able to disagree with itself.
      expect(() =>
        registerChannel(backendDb, { platform: "instagram_stories", locale: "ru", provider: "native", targetId: "instagram_stories_ru" }),
      ).toThrow("served by the Instagram account");
    }));

  it("uses only registered targets when creating publication jobs", () =>
    withDb((backendDb) => {
      backendDb.db.delete(channelConnections).run();
      const now = new Date().toISOString();
      for (const channel of [
        { id: "telegram", platform: "telegram", locale: "ru", targetId: "telegram", label: "Telegram RU" },
        { id: "threads_ru", platform: "threads", locale: "ru", targetId: "threads_ru", label: "Threads RU" },
      ])
        backendDb.channels.upsert(
          {
            ...channel,
            provider: "native",
            providerAccountId: null,
            enabled: 1,
            source: "fixture",
          },
          now,
        );

      expect(listChannels(backendDb).map((channel) => channel.targetId)).toEqual(["telegram", "threads_ru"]);
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

  it("refuses to publish when the registry has no publication targets", () =>
    withDb((backendDb) => {
      backendDb.db.delete(channelConnections).run();
      const draftId = createDraftFromMessage(backendDb, 1, { text: "No route", entities: [], media: [] });

      // It used to create the publication anyway: no jobs behind it, and a
      // `scheduled` row that no worker would pick up and no status would ever
      // move — an upcoming post that was never going anywhere.
      expect(() => publishDraftToQueue(backendDb, draftId)).toThrow("Публиковать некуда");
      expect(backendDb.db.select({ target: publishJobs.target }).from(publishJobs).all()).toEqual([]);
    }));
});
