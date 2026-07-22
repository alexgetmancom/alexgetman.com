import { describe, expect, it } from "bun:test";
import { slugify } from "../src/content/message.js";

describe("slugify", () => {
  it("preserves Cyrillic letters with diacritics", () => {
    expect(slugify("Claude Code получил встроенный браузер", 54)).toBe("claude-code-получил-встроенный-браузер");
    expect(slugify("Ёлки и йога", 55)).toBe("ёлки-и-йога");
  });
});
