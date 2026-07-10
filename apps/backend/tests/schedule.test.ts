import { describe, expect, it } from "vitest";
import { openBackendDb } from "../src/db/client.js";
import { nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, schedulePreset } from "../src/publishingSchedule.js";

describe("publishing schedule", () => {
  it("uses independent fixed MSK slot grids and skips occupied slots", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date("2026-07-10T05:00:00.000Z"); // 08:00 MSK
      expect(nextPublishingSlot(backendDb, "ru", now).toISOString()).toBe("2026-07-10T07:37:00.000Z");
      expect(nextPublishingSlot(backendDb, "en", now).toISOString()).toBe("2026-07-10T14:37:00.000Z");
      backendDb.sqlite
        .prepare(
          "INSERT INTO drafts(admin_id,status,text_ru,targets_json,scheduled_at,created_at,updated_at) VALUES (1,'scheduled','x','{}',?,?,?)",
        )
        .run("2026-07-10T07:37:00.000Z", now.toISOString(), now.toISOString());
      expect(nextPublishingSlot(backendDb, "ru", now).toISOString()).toBe("2026-07-10T10:37:00.000Z");
    } finally {
      backendDb.close();
    }
  });

  it("parses manual MSK times and presets", () => {
    const now = new Date("2026-07-10T15:00:00.000Z"); // 18:00 MSK
    expect(parseManualSchedule("21:15", now).toISOString()).toBe("2026-07-10T18:15:00.000Z");
    expect(parseManualSchedule("09:00", now).toISOString()).toBe("2026-07-11T06:00:00.000Z");
    expect(parseManualSchedule("12.07 10:30", now).toISOString()).toBe("2026-07-12T07:30:00.000Z");
    expect(schedulePreset("plus30", now).toISOString()).toBe("2026-07-10T15:30:00.000Z");
    expect(schedulePreset("today2100", now).toISOString()).toBe("2026-07-10T18:00:00.000Z");
    expect(schedulePreset("tomorrow1000", now).toISOString()).toBe("2026-07-11T07:00:00.000Z");
  });

  it("rebalances scheduled drafts and their queued jobs by locale", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date("2026-07-10T05:00:00.000Z");
      const createdAt = now.toISOString();
      const first = Number(
        backendDb.sqlite
          .prepare(
            "INSERT INTO drafts(admin_id,status,text_ru,targets_json,scheduled_at,created_at,updated_at) VALUES (1,'scheduled','one','{\"site_ru\":true}',?,?,?)",
          )
          .run("2026-07-11T07:37:00.000Z", createdAt, createdAt).lastInsertRowid,
      );
      const second = Number(
        backendDb.sqlite
          .prepare(
            "INSERT INTO drafts(admin_id,status,text_ru,targets_json,scheduled_at,created_at,updated_at) VALUES (1,'scheduled','two','{\"site_ru\":true}',?,?,?)",
          )
          .run("2026-07-12T07:37:00.000Z", createdAt, createdAt).lastInsertRowid,
      );
      backendDb.sqlite.prepare("UPDATE drafts SET post_id=? WHERE id=?").run(101, first);
      backendDb.sqlite.prepare("UPDATE drafts SET post_id=? WHERE id=?").run(102, second);
      backendDb.sqlite
        .prepare(
          "INSERT INTO publish_jobs(post_id,message_id,target,payload_json,status,next_attempt_at,created_at,updated_at) VALUES (101,101,'telegram','{}','queued',?,?,?)",
        )
        .run(createdAt, createdAt, createdAt);
      backendDb.sqlite
        .prepare(
          "INSERT INTO publish_jobs(post_id,message_id,target,payload_json,status,next_attempt_at,created_at,updated_at) VALUES (102,102,'telegram','{}','queued',?,?,?)",
        )
        .run(createdAt, createdAt, createdAt);

      expect(rebalanceScheduledDrafts(backendDb, now)).toBe(2);
      const drafts = backendDb.sqlite
        .prepare("SELECT id, scheduled_at FROM drafts WHERE id IN (?,?) ORDER BY id")
        .all(first, second) as Array<{ id: number; scheduled_at: string }>;
      expect(drafts.map((draft) => draft.scheduled_at)).toEqual(["2026-07-10T07:37:00.000Z", "2026-07-10T10:37:00.000Z"]);
      const jobs = backendDb.sqlite.prepare("SELECT next_attempt_at FROM publish_jobs ORDER BY post_id").all() as Array<{
        next_attempt_at: string;
      }>;
      expect(jobs.map((job) => job.next_attempt_at)).toEqual(drafts.map((draft) => draft.scheduled_at));
    } finally {
      backendDb.close();
    }
  });
});
