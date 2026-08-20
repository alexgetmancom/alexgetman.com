import { describe, expect, it } from "bun:test";
import { parseMarkdownArticle } from "../src/content/markdown.js";
import { entitiesToHtml } from "../src/content/text.js";
import { toContentState } from "../src/delivery/social/x-content-state.js";

describe("markdown article ingestion", () => {
  it("takes the first h1 as the title and leaves it out of the body", () => {
    const { title, body } = parseMarkdownArticle("# Real title\n\nFirst paragraph.");
    expect(title).toBe("Real title");
    expect(body.text).toBe("First paragraph.");
  });

  it("reports no title rather than inventing one from the first line", () => {
    const { title, body } = parseMarkdownArticle("Just prose, no heading.");
    expect(title).toBe("");
    expect(body.text).toBe("Just prose, no heading.");
  });

  it("measures entity offsets against the stripped text, not the marked-up source", () => {
    const { body } = parseMarkdownArticle("# T\n\nplain **bold** tail");
    expect(body.text).toBe("plain bold tail");
    expect(body.entities).toEqual([{ type: "bold", offset: 6, length: 4 }]);
  });

  it("keeps later offsets correct after an earlier marker is removed", () => {
    const { body } = parseMarkdownArticle("**one** and *two*");
    expect(body.text).toBe("one and two");
    expect(body.entities).toEqual([
      { type: "bold", offset: 0, length: 3 },
      { type: "italic", offset: 8, length: 3 },
    ]);
  });

  it("carries a link's url on the entity and its label in the text", () => {
    const { body } = parseMarkdownArticle("see [the notes](https://example.com/n) here");
    expect(body.text).toBe("see the notes here");
    expect(body.entities).toEqual([{ type: "text_link", offset: 4, length: 9, url: "https://example.com/n" }]);
  });

  it("keeps the label but drops a non-http link target", () => {
    const { body } = parseMarkdownArticle("[click](javascript:alert)");
    expect(body.text).toBe("click");
    expect(body.entities).toEqual([]);
  });

  it("marks headings with their level and normalizes both list markers", () => {
    const { body } = parseMarkdownArticle("## Section\n\n- first\n2. second");
    expect(body.text).toBe("Section\n\nfirst\nsecond");
    expect(body.entities).toEqual([
      { type: "heading", offset: 0, length: 7, level: 2 },
      { type: "list_item", offset: 9, length: 5 },
      { type: "list_item", offset: 15, length: 6 },
    ]);
  });

  it("renders one parsed article the same way on both targets", () => {
    const { body } = parseMarkdownArticle("## Section\n\nA **bold** [link](https://example.com).");
    const html = entitiesToHtml(body.text, body.entities as Record<string, unknown>[]);
    const state = toContentState(body.text, body.entities as Record<string, unknown>[]);
    expect(html).toContain("<h2>Section</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(state.blocks[0]?.type).toBe("header-two");
    expect(state.blocks[1]?.inline_style_ranges).toEqual([{ offset: 2, length: 4, style: "BOLD" }]);
    expect(state.entity_map["0"]?.data).toEqual({ url: "https://example.com" });
  });
});
