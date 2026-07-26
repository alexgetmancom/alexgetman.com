import { describe, expect, it } from "bun:test";
import { formatVideoTime } from "../src/interfaces/telegram/video-time.js";

const msk = { TIMEZONE: "Europe/Moscow", TIMEZONE_LABEL: "MSK" };

describe("formatVideoTime", () => {
  it("formats a UTC instant in the configured zone", () => {
    // 2026-01-15T09:30:00Z is 12:30 in Europe/Moscow (UTC+3, no DST).
    expect(formatVideoTime("2026-01-15T09:30:00Z", "ru", msk)).toBe("15.01.2026, 12:30 MSK");
  });

  it("follows the configured zone rather than a hardcoded Moscow", () => {
    expect(formatVideoTime("2026-01-15T09:30:00Z", "en", { TIMEZONE: "Europe/Belgrade", TIMEZONE_LABEL: "CET" })).toBe(
      "15.01.2026, 10:30 CET",
    );
  });

  it("reports the unset placeholder per locale when there is no value", () => {
    expect(formatVideoTime(null, "ru", msk)).toBe("время не задано");
    expect(formatVideoTime(null, "en", msk)).toBe("time is not set");
  });
});
