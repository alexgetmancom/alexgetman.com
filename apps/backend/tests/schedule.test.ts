import { describe, expect, it } from "bun:test";
import { InlineKeyboard } from "grammy";
import {
  appendScheduleAxisButtons,
  createPublicationScheduleEngine,
  SCHEDULE_SLOT_PRESETS,
  scheduleTimeKeyboard,
} from "../src/bot/scheduling.js";
import { StudioError } from "../src/foundation/errors.js";
import { parseManualSchedule, publicationSlotTime } from "../src/publishing/schedule.js";

function expectStudioError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected StudioError to be thrown");
  } catch (error) {
    expect(error).toBeInstanceOf(StudioError);
    expect((error as StudioError).code).toBe(code);
  }
}

describe("publishing schedule", () => {
  it("uses one callback protocol for locale and target schedule axes", () => {
    const engine = createPublicationScheduleEngine({
      kind: "video",
      publicationId: 7,
      scheduleAxis: "target",
      axisKeys: ["youtube_shorts", "instagram_reels"],
      axisLabel: (key) => key,
      slotValues: SCHEDULE_SLOT_PRESETS,
    });

    expect(engine.scheduleAxis).toBe("target");
    expect(engine.axisKeys).toEqual(["youtube_shorts", "instagram_reels"]);
    expect(engine.axisLabel("youtube_shorts")).toBe("youtube_shorts");
    expect(engine.pickCallback("youtube_shorts", "08:00")).toBe("p:video:sched_pick:7:youtube_shorts:0800");
    expect(engine.manualCallback("youtube_shorts")).toBe("p:video:sched_manual:7:youtube_shorts");
    expect(engine.confirmCallback()).toBe("p:video:sched_confirm:7");
  });

  it("renders every scheduling axis in the shared two-column picker", () => {
    const keyboard = scheduleTimeKeyboard({
      axis: {
        values: SCHEDULE_SLOT_PRESETS,
        label: (clock) => clock,
        callback: (clock) => `pick:${clock.replace(":", "")}`,
      },
      revision: 7,
      manual: { label: "Manual", callback: "manual" },
      cancel: { label: "Cancel", callback: "cancel" },
    });

    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "08:00", callback_data: "sv7|pick:0800" },
        { text: "11:00", callback_data: "sv7|pick:1100" },
      ],
      [
        { text: "13:00", callback_data: "sv7|pick:1300" },
        { text: "18:00", callback_data: "sv7|pick:1800" },
      ],
      [
        { text: "20:00", callback_data: "sv7|pick:2000" },
        { text: "22:00", callback_data: "sv7|pick:2200" },
      ],
      [{ text: "Manual", callback_data: "sv7|manual" }],
      [{ text: "Cancel", callback_data: "sv7|cancel" }],
    ]);
  });

  it("can render a domain-specific axis without changing its callback protocol", () => {
    const keyboard = appendScheduleAxisButtons(new InlineKeyboard(), {
      values: ["ru-morning", "ru-evening"],
      label: (value: string) => value.replace("ru-", ""),
      callback: (value: string) => `sched:${value}`,
    });

    expect(keyboard.inline_keyboard).toEqual([
      [
        { text: "morning", callback_data: "sched:ru-morning" },
        { text: "evening", callback_data: "sched:ru-evening" },
      ],
    ]);
  });

  it("parses manual MSK times and resolves slot-button clocks", () => {
    const now = new Date("2026-07-10T15:00:00.000Z"); // 18:00 MSK
    expect(parseManualSchedule("21:15", "Europe/Moscow", now).toISOString()).toBe("2026-07-10T18:15:00.000Z");
    expect(parseManualSchedule("09:00", "Europe/Moscow", now).toISOString()).toBe("2026-07-11T06:00:00.000Z");
    expect(parseManualSchedule("12.07 10:30", "Europe/Moscow", now).toISOString()).toBe("2026-07-12T07:30:00.000Z");
    expect(publicationSlotTime("21:00", "Europe/Moscow", now).toISOString()).toBe("2026-07-10T18:00:00.000Z");
    expect(publicationSlotTime("10:00", "Europe/Moscow", now).toISOString()).toBe("2026-07-11T07:00:00.000Z");
    expectStudioError(() => parseManualSchedule("25:00", "Europe/Moscow", now), "common.schedule-parse-error");
    expectStudioError(() => parseManualSchedule("31.02 10:00", "Europe/Moscow", now), "common.schedule-parse-error");
    expectStudioError(() => parseManualSchedule("01.01.2020 10:00", "Europe/Moscow", now), "err.schedule-time-past");
  });

  it("resolves valid wall-clock times on both sides of DST transitions", () => {
    const zone = "America/New_York";
    const springNow = new Date("2026-03-07T12:00:00.000Z");
    expect(parseManualSchedule("08.03 01:30", zone, springNow).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(parseManualSchedule("08.03 03:30", zone, springNow).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(publicationSlotTime("01:30", zone, new Date("2026-03-07T08:00:00.000Z")).toISOString()).toBe("2026-03-08T06:30:00.000Z");
    const fallNow = new Date("2026-10-31T12:00:00.000Z");
    // When a wall clock occurs twice, choose the first occurrence so the slot
    // never silently moves later than the operator requested.
    expect(parseManualSchedule("01.11 01:30", zone, fallNow).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expectStudioError(() => parseManualSchedule("08.03 02:30", zone, springNow), "common.schedule-parse-error");
  });
});
