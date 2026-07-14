import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { formatDate } from "./dates";
import { semanticPostHtml } from "./html";
import { responsiveImageSrcSet } from "./media";
import { getSmartBadge } from "./taxonomy";
import { excerptAfterTitle, removeLeadingEmoji } from "./text";

describe("focused web helpers", () => {
  it("keeps presentation behavior after the physical split", () => {
    expect(removeLeadingEmoji("🇷🇺 Текст")).toBe("Текст");
    expect(excerptAfterTitle("Title: A useful summary with enough detail to render", "Title", 80)).toBe(
      "A useful summary with enough detail to render",
    );
    expect(getSmartBadge("OpenAI released a model").class).toBe("badge--ai");
    expect(responsiveImageSrcSet("media/image.jpg")).toContain("image-640.webp 640w");
    expect(semanticPostHtml("First\n\n- one\n- two")).toBe("<p>First</p>\n<ul><li>one</li><li>two</li></ul>");
    expect(formatDate("2026-07-15T10:00:00.000Z")).toContain("2026");
  });

  it("has no legacy helper facade", () => {
    expect(existsSync(new URL("./helpers.ts", import.meta.url))).toBe(false);
  });
});
