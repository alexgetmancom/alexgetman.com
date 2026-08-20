import { describe, expect, it } from "bun:test";
import { toContentState } from "../src/delivery/social/x-content-state.js";

describe("X article content_state", () => {
  it("splits paragraphs into blocks and drops the blank separator lines", () => {
    const state = toContentState("First paragraph.\n\nSecond paragraph.", []);
    expect(state.blocks.map((block) => block.text)).toEqual(["First paragraph.", "Second paragraph."]);
    expect(state.blocks.every((block) => block.type === "unstyled")).toBe(true);
  });

  it("keeps inline ranges relative to their own block, not to the whole body", () => {
    // "bold" sits at offset 24 of the body but at offset 7 of its own line.
    const text = "Intro line.\n\nSecond bold tail.";
    const state = toContentState(text, [{ type: "bold", offset: text.indexOf("bold"), length: 4 }]);
    expect(state.blocks[1]?.inline_style_ranges).toEqual([{ offset: 7, length: 4, style: "BOLD" }]);
    expect(state.blocks[0]?.inline_style_ranges).toEqual([]);
  });

  it("carries a link as an entity rather than as text, which is what keeps it out of the post body", () => {
    const text = "Read the notes here.";
    const state = toContentState(text, [{ type: "text_link", offset: 15, length: 4, url: "https://example.com/notes" }]);
    expect(state.entity_map["0"]).toEqual({ type: "LINK", mutability: "MUTABLE", data: { url: "https://example.com/notes" } });
    expect(state.blocks[0]?.entity_ranges).toEqual([{ offset: 15, length: 4, key: 0 }]);
    expect(state.blocks[0]?.text).toBe(text);
  });

  it("promotes a line fully covered by a heading entity, and leaves a partial one inline", () => {
    const text = "Chapter one\nA heading word inside prose";
    const state = toContentState(text, [
      { type: "heading", offset: 0, length: 11, level: 2 },
      { type: "heading", offset: 14, length: 7, level: 2 },
    ]);
    expect(state.blocks[0]?.type).toBe("header-two");
    expect(state.blocks[1]?.type).toBe("unstyled");
  });

  it("reads the heading level instead of assuming one", () => {
    const state = toContentState("Title", [{ type: "heading", offset: 0, length: 5, level: 1 }]);
    expect(state.blocks[0]?.type).toBe("header-one");
  });

  it("refuses a javascript: url the way the HTML renderer does", () => {
    const state = toContentState("click", [{ type: "text_link", offset: 0, length: 5, url: "javascript:alert(1)" }]);
    expect(state.entity_map).toEqual({});
    expect(state.blocks[0]?.entity_ranges).toEqual([]);
  });

  it("resolves a schemeless bare url the same way Telegram auto-detects one", () => {
    const state = toContentState("go to example.com now", [{ type: "url", offset: 6, length: 11 }]);
    expect(state.entity_map["0"]?.data).toEqual({ url: "https://example.com" });
  });

  it("appends uploaded media as atomic blocks and never renumbers an existing entity key", () => {
    const state = toContentState("Body with a link.", [{ type: "text_link", offset: 12, length: 4, url: "https://example.com" }], ["77"]);
    expect(state.blocks.at(-1)).toEqual({
      key: "m0",
      text: " ",
      type: "atomic",
      depth: 0,
      inline_style_ranges: [],
      entity_ranges: [{ offset: 0, length: 1, key: 1 }],
    });
    expect(state.entity_map["0"]?.type).toBe("LINK");
    expect(state.entity_map["1"]).toEqual({ type: "MEDIA", mutability: "IMMUTABLE", data: { media_id: "77" } });
  });

  it("emits one empty block for an empty body, because the draft endpoint rejects no blocks", () => {
    expect(toContentState("", []).blocks).toEqual([
      { key: "b0", text: "", type: "unstyled", depth: 0, inline_style_ranges: [], entity_ranges: [] },
    ]);
  });

  it("ignores an entity that runs past the end of the text", () => {
    const state = toContentState("short", [{ type: "bold", offset: 3, length: 99 }]);
    expect(state.blocks[0]?.inline_style_ranges).toEqual([]);
  });
});
