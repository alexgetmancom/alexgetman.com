import { describe, expect, it } from "bun:test";
import { renderPeriodControls, rollingPeriodDates } from "../src/interfaces/web/dashboard/period-controls.js";

describe("command center period controls", () => {
  it("offers one day first and keeps a selected platform when changing periods", () => {
    const html = renderPeriodControls("ru", 0, 1, "Europe/Moscow", "threads_en", "&metric=followers");

    expect(html).toContain(">1д<");
    expect(html).toContain("view=threads_en");
    expect(html).toContain("metric=followers");
    expect(html).toContain(">30д<");
  });

  it("returns UTC calendar dates for the configured timezone", () => {
    const [start, end] = rollingPeriodDates(0, 1, "Europe/Moscow");

    expect(start.toISOString().slice(0, 10)).toBe(end.toISOString().slice(0, 10));
  });
});
