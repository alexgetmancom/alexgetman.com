import { describe, expect, it } from "bun:test";
import {
  formatZonedDateTime,
  formatZonedSortable,
  timezoneOffsetMs,
  zonedDateParts,
  zonedSlot,
  zonedWeekBounds,
} from "../src/foundation/time.js";

describe("foundation/time", () => {
  it("resolves the configured IANA zone's offset from the actual civil time", () => {
    expect(timezoneOffsetMs(new Date("2026-07-18T12:00:00Z"), "Europe/Moscow")).toBe(3 * 3_600_000);
    expect(timezoneOffsetMs(new Date("2026-07-18T12:00:00Z"), "UTC")).toBe(0);
  });

  it("reads the calendar date as it appears in the configured zone", () => {
    // 23:30 UTC on the 17th is already the 18th in Moscow (+3).
    expect(zonedDateParts(new Date("2026-07-17T23:30:00Z"), "Europe/Moscow")).toEqual({ year: 2026, month: 7, day: 18 });
  });

  it("builds the instant at which the zone's wall clock reads a given time", () => {
    const slot = zonedSlot(2026, 7, 18, "18:30", "Europe/Moscow");
    expect(slot.toISOString()).toBe("2026-07-18T15:30:00.000Z");
  });

  it("formats a display string with the configured label, default Moscow behavior unchanged", () => {
    expect(formatZonedDateTime("2026-07-18T15:30:00.000Z", "Europe/Moscow", "MSK")).toBe("18.07.2026, 18:30 MSK");
    expect(formatZonedDateTime(null, "Europe/Moscow", "MSK")).toBe("-");
  });

  it("supports a non-Moscow configured zone end to end", () => {
    const slot = zonedSlot(2026, 7, 18, "09:00", "America/New_York");
    expect(formatZonedDateTime(slot, "America/New_York", "ET")).toBe("18.07.2026, 09:00 ET");
  });

  it("formats a sortable reading in the configured zone", () => {
    expect(formatZonedSortable("2026-07-18T15:30:00.000Z", "Europe/Moscow")).toBe("2026-07-18 18:30");
  });

  it("computes Monday-start week bounds in the configured zone", () => {
    const [start, end] = zonedWeekBounds(0, "Europe/Moscow", new Date("2026-07-18T12:00:00Z"));
    expect(start).toBe("2026-07-12T21:00:00.000Z");
    expect(end).toBe("2026-07-19T20:59:59.999Z");
  });
});
