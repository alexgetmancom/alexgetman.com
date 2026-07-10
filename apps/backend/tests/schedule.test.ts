import { describe, expect, it } from "vitest";
import { openBackendDb } from "../src/db/client.js";
import { nextPublishingSlot, parseManualSchedule, schedulePreset } from "../src/publishingSchedule.js";

describe("publishing schedule", () => {
  it("uses independent fixed MSK slot grids and skips occupied slots", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const now = new Date("2026-07-10T05:00:00.000Z"); // 08:00 MSK
      expect(nextPublishingSlot(backendDb, "ru", now).toISOString()).toBe("2026-07-10T07:37:00.000Z");
      expect(nextPublishingSlot(backendDb, "en", now).toISOString()).toBe("2026-07-10T14:37:00.000Z");
      backendDb.sqlite.prepare("INSERT INTO drafts(admin_id,status,text_ru,targets_json,scheduled_at,created_at,updated_at) VALUES (1,'scheduled','x','{}',?,?,?)")
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
});
