import { describe, expect, it } from "bun:test";
import {
  formatPlatformText,
  PLATFORM_PROFILES,
  platformAnalyticsProfile,
  platformProfile,
  videoBounds,
} from "../src/publishing/platform-profiles.js";

describe("platform profiles", () => {
  it("keeps platform-specific text formatting declarative", () => {
    expect(formatPlatformText("x", "Read https://example.com now")).toBe("Read now");
    expect(formatPlatformText("x", "First paragraph\n\nSecond https://example.com/link paragraph")).toBe(
      "First paragraph\n\nSecond paragraph",
    );
    expect(formatPlatformText("telegram", "Read https://example.com now")).toBe("Read https://example.com now");
  });

  it("publishes media bounds only for targets that declare them", () => {
    expect(videoBounds("threads_en", 1920, 1080)).toEqual({ maxWidth: 1920, maxHeight: 1080 });
    expect(videoBounds("threads_ru", 1080, 1920)).toEqual({ maxWidth: 1080, maxHeight: 1920 });
    expect(videoBounds("telegram", 1920, 1080)).toBeNull();
    expect(platformProfile("x")?.requirements).toContain("X_ACCESS_TOKEN");
  });

  it("declares capabilities and media behaviour for every configured target", () => {
    expect(Object.keys(PLATFORM_PROFILES)).toHaveLength(17);
    expect(platformProfile("telegram")?.media).toMatchObject({ mode: "limited", limit: 10 });
    expect(platformProfile("site_ru")?.media).toMatchObject({ mode: "all" });
    expect(platformProfile("telegram_stories")?.media).toMatchObject({ mode: "story-first" });
    expect(platformProfile("facebook")?.media?.whenVideo).toMatchObject({ mode: "first" });
  });

  it("declares analytics support beside publishing capabilities", () => {
    expect(platformAnalyticsProfile("telegram")).toMatchObject({ enabled: true, source: "t_me_public" });
    expect(platformAnalyticsProfile("site_ru")).toMatchObject({ enabled: false });
  });
});
