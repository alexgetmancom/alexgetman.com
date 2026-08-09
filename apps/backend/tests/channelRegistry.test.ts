import { describe, expect, it } from "bun:test";
import { channelForVideo, listChannels, registerChannel } from "../src/channels/registry.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { channelConnections, publishJobs } from "../src/db/schema.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { withDb } from "./helpers/db.js";

describe("channel registry", () => {
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

  it("creates no jobs when the registry has no publication targets", () =>
    withDb((backendDb) => {
      backendDb.db.delete(channelConnections).run();
      const draftId = createDraftFromMessage(backendDb, 1, { text: "No route", entities: [], media: [] });
      publishDraftToQueue(backendDb, draftId);
      expect(backendDb.db.select({ target: publishJobs.target }).from(publishJobs).all()).toEqual([]);
    }));
});
