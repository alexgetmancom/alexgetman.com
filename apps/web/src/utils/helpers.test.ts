import { describe, expect, it } from "bun:test";
import { stripLeadingEmojis } from "../../../backend/src/content/text.js";
import { formatDate } from "./dates";
import { semanticPostHtml } from "./html";
import { responsiveImageSrcSet } from "./media";
import { getSmartBadge } from "./taxonomy";
import { excerptAfterTitle } from "./text";

describe("focused web helpers", () => {
  it("removes a leading flag emoji from a post title", () => {
    expect(stripLeadingEmojis("🇷🇺 Текст")).toBe("Текст");
  });

  it("extracts the body after a post title", () => {
    expect(excerptAfterTitle("Title: A useful summary with enough detail to render", "Title", 80)).toBe(
      "A useful summary with enough detail to render",
    );
  });

  it("classifies an AI post with the AI badge", () => {
    expect(getSmartBadge("OpenAI released a model").class).toBe("badge--ai");
  });

  it("builds responsive image sources", () => {
    expect(responsiveImageSrcSet("media/image.jpg")).toContain("image-640.webp 640w");
  });

  it("renders markdown as semantic post HTML", () => {
    expect(semanticPostHtml("First\n\n- one\n- two")).toBe("<p>First</p>\n<ul><li>one</li><li>two</li></ul>");
  });

  it("formats a date for the site", () => {
    expect(formatDate("2026-07-15T10:00:00.000Z")).toContain("2026");
  });
});
