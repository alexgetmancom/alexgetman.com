import { describe, expect, it } from "bun:test";
import { escapeMarkdown } from "../src/foundation/markdown.js";
import { truncateUnicode } from "../src/foundation/text.js";

describe("foundation/text", () => {
  it("escapes Markdown control characters and literal backslashes", () => {
    const value = String.raw`path\to\file_*[]`;
    expect(escapeMarkdown(value)).toBe(String.raw`path\\to\\file\_\*\[\]`);
  });

  it("does not split a Unicode code point at the limit", () => {
    expect(truncateUnicode("123😀", 4)).toBe("123😀");
    expect(truncateUnicode("123😀", 3)).toBe("123");
  });

  it("repairs lone UTF-16 surrogates before Telegram receives the text", () => {
    const value = `before${String.fromCharCode(0xd83d)}after`;
    const result = truncateUnicode(value, 20);
    expect(result).toBe("before�after");
    expect(result).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  // Truncating escaped text can cut between a backslash and the character it
  // escapes, and Telegram rejects a message ending in a lone backslash.
  it("leaves no dangling escape when truncation precedes escaping", () => {
    const value = `${"x".repeat(179)}*tail*`;
    expect(truncateUnicode(escapeMarkdown(value), 180)).toMatch(/(^|[^\\])\\$/);
    expect(escapeMarkdown(truncateUnicode(value, 180))).not.toMatch(/(^|[^\\])\\$/);
  });
});
