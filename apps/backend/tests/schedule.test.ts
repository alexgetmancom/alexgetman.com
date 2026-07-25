import { describe, expect, it } from "bun:test";
import { StudioError } from "../src/foundation/errors.js";
import { parseManualSchedule, scheduleClockToday } from "../src/publishing/schedule.js";

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
  it("parses manual MSK times and resolves slot-button clocks", () => {
    const now = new Date("2026-07-10T15:00:00.000Z"); // 18:00 MSK
    expect(parseManualSchedule("21:15", now).toISOString()).toBe("2026-07-10T18:15:00.000Z");
    expect(parseManualSchedule("09:00", now).toISOString()).toBe("2026-07-11T06:00:00.000Z");
    expect(parseManualSchedule("12.07 10:30", now).toISOString()).toBe("2026-07-12T07:30:00.000Z");
    expect(scheduleClockToday("21:00", now).toISOString()).toBe("2026-07-10T18:00:00.000Z");
    expect(scheduleClockToday("10:00", now).toISOString()).toBe("2026-07-11T07:00:00.000Z");
    expectStudioError(() => parseManualSchedule("25:00", now), "common.schedule-parse-error");
    expectStudioError(() => parseManualSchedule("31.02 10:00", now), "common.schedule-parse-error");
    expectStudioError(() => parseManualSchedule("01.01.2020 10:00", now), "err.schedule-time-past");
  });
});
