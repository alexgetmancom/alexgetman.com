import { describe, expect, it } from "bun:test";
import { formatPlatformText, platformProfile, videoBounds } from "../src/publishing/platform-profiles.js";

describe("platform profiles", () => {
  it("keeps platform-specific text formatting declarative", () => {
    expect(formatPlatformText("x", "Read https://example.com now")).toBe("Read now");
    expect(formatPlatformText("telegram", "Read https://example.com now")).toBe("Read https://example.com now");
  });

  it("publishes media bounds only for targets that declare them", () => {
    expect(videoBounds("threads_en", 1920, 1080)).toEqual({ maxWidth: 1920, maxHeight: 1080 });
    expect(videoBounds("threads_ru", 1080, 1920)).toEqual({ maxWidth: 1080, maxHeight: 1920 });
    expect(videoBounds("telegram", 1920, 1080)).toBeNull();
    expect(platformProfile("x")?.requirements).toContain("X_ACCESS_TOKEN");
  });
});
