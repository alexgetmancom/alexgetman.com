import { describe, expect, it } from "bun:test";
import { truncateUnicode } from "../src/foundation/text.js";

describe("foundation/text", () => {
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
});
