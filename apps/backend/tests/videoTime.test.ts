import { describe, expect, it } from "bun:test";
import { formatVideoTime } from "../src/interfaces/telegram/video-time.js";

describe("formatVideoTime", () => {
  it("formats a UTC instant in Moscow time for the ru locale", () => {
    // 2026-01-15T09:30:00Z is 12:30 in Europe/Moscow (UTC+3, no DST).
    expect(formatVideoTime("2026-01-15T09:30:00Z", "ru")).toBe("15.01.2026, 12:30");
  });

  it("formats a UTC instant in Moscow time for the en locale", () => {
    expect(formatVideoTime("2026-01-15T09:30:00Z", "en")).toBe("15/01/2026, 12:30");
  });

  it("defaults to the ru locale when none is given", () => {
    expect(formatVideoTime("2026-01-15T09:30:00Z")).toBe(formatVideoTime("2026-01-15T09:30:00Z", "ru"));
  });

  it("reports the unset placeholder per locale when there is no value", () => {
    expect(formatVideoTime(null, "ru")).toBe("время не задано");
    expect(formatVideoTime(null, "en")).toBe("time is not set");
  });
});
