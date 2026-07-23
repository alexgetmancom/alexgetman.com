import { describe, expect, it } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { openBackendDb } from "../src/db/client.js";
import { drafts, publishJobs } from "../src/db/schema.js";
import { nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, scheduleClockToday } from "../src/publishing/schedule.js";

describe("publishing schedule", () => {
  it("uses independent fixed MSK slot grids and skips occupied slots", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date("2026-07-10T05:00:00.000Z"); // 08:00 MSK
      expect(nextPublishingSlot(backendDb, "ru", now).toISOString()).toBe("2026-07-10T06:00:00.000Z");
      expect(nextPublishingSlot(backendDb, "en", now).toISOString()).toBe("2026-07-10T15:00:00.000Z");
      backendDb.db
        .insert(drafts)
        .values({
          adminId: 1,
          status: "scheduled",
          textRu: "x",
          targetsJson: "{}",
          scheduledAt: "2026-07-10T06:00:00.000Z",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
      expect(nextPublishingSlot(backendDb, "ru", now).toISOString()).toBe("2026-07-10T07:00:00.000Z");
    } finally {
      backendDb.close();
    }
  });

  it("parses manual MSK times and resolves slot-button clocks", () => {
    const now = new Date("2026-07-10T15:00:00.000Z"); // 18:00 MSK
    expect(parseManualSchedule("21:15", now).toISOString()).toBe("2026-07-10T18:15:00.000Z");
    expect(parseManualSchedule("09:00", now).toISOString()).toBe("2026-07-11T06:00:00.000Z");
    expect(parseManualSchedule("12.07 10:30", now).toISOString()).toBe("2026-07-12T07:30:00.000Z");
    expect(scheduleClockToday("21:00", now).toISOString()).toBe("2026-07-10T18:00:00.000Z");
    expect(scheduleClockToday("10:00", now).toISOString()).toBe("2026-07-11T07:00:00.000Z");
    expect(() => parseManualSchedule("25:00", now)).toThrow("valid HH:MM");
    expect(() => parseManualSchedule("31.02 10:00", now)).toThrow("valid calendar date");
    expect(() => parseManualSchedule("01.01.2020 10:00", now)).toThrow("future");
  });

  it("rebalances scheduled drafts and their queued jobs by locale", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date("2026-07-10T05:00:00.000Z");
      const createdAt = now.toISOString();
      const first = backendDb.db
        .insert(drafts)
        .values({
          adminId: 1,
          status: "scheduled",
          textRu: "one",
          targetsJson: '{"site_ru":true}',
          scheduledAt: "2026-07-11T06:00:00.000Z",
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: drafts.id })
        .get()?.id;
      const second = backendDb.db
        .insert(drafts)
        .values({
          adminId: 1,
          status: "scheduled",
          textRu: "two",
          targetsJson: '{"site_ru":true}',
          scheduledAt: "2026-07-12T06:00:00.000Z",
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: drafts.id })
        .get()?.id;
      backendDb.db.update(drafts).set({ postId: 101 }).where(eq(drafts.id, first)).run();
      backendDb.db.update(drafts).set({ postId: 102 }).where(eq(drafts.id, second)).run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 101,
          messageId: 101,
          target: "telegram",
          payloadJson: {},
          status: "queued",
          nextAttemptAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 102,
          messageId: 102,
          target: "telegram",
          payloadJson: {},
          status: "queued",
          nextAttemptAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
        .run();

      expect(rebalanceScheduledDrafts(backendDb, now)).toBe(2);
      const scheduledDrafts = backendDb.db
        .select({ id: drafts.id, scheduledAt: drafts.scheduledAt })
        .from(drafts)
        .where(inArray(drafts.id, [first, second]))
        .orderBy(asc(drafts.id))
        .all();
      expect(scheduledDrafts.map((draft) => draft.scheduledAt)).toEqual(["2026-07-10T06:00:00.000Z", "2026-07-10T07:00:00.000Z"]);
      const jobs = backendDb.db
        .select({ publishAt: publishJobs.publishAt, nextAttemptAt: publishJobs.nextAttemptAt, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .orderBy(asc(publishJobs.postId))
        .all();
      const scheduledAt = scheduledDrafts.map((draft) => draft.scheduledAt ?? "");
      expect(jobs.map((job) => job.publishAt)).toEqual(scheduledAt);
      expect(jobs.map((job) => job.nextAttemptAt)).toEqual(scheduledAt);
      expect(jobs.map((job) => (job.payloadJson as { publish_at_ru: string }).publish_at_ru)).toEqual(scheduledAt);
    } finally {
      backendDb.close();
    }
  });
});
