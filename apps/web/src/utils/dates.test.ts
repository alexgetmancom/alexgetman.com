import { describe, expect, it } from "bun:test";
import { formatRelativeTime } from "./dates";

describe("formatRelativeTime", () => {
  it("formats minutes, hours and days in English", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), "en")).toBe("5 minutes ago");
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), "en")).toBe("3 hours ago");
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), "en")).toBe("2 days ago");
  });

  it("formats in Russian when asked", () => {
    const now = Date.now();
    expect(formatRelativeTime(new Date(now - 10 * 60_000).toISOString(), "ru")).toContain("минут");
  });

  it("returns an empty string for an invalid date instead of throwing", () => {
    expect(formatRelativeTime("not-a-date")).toBe("");
  });
});
