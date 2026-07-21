import { describe, expect, it } from "bun:test";
import { compactText, getFirstSentence, truncateText } from "./text";

describe("compactText", () => {
  it("strips tags, collapses whitespace and decodes basic entities", () => {
    expect(compactText("<p>Hello&nbsp;&amp;&nbsp;world</p>")).toBe("Hello & world");
  });

  it("collapses runs of blank lines and trims", () => {
    expect(compactText("  First line  \n\n\n\nSecond line  ")).toBe("First line Second line");
  });

  it("returns an empty string for empty input", () => {
    expect(compactText("")).toBe("");
  });
});

describe("truncateText", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(truncateText("Short text", 80)).toBe("Short text");
  });

  it("cuts on a word boundary and appends an ellipsis", () => {
    const result = truncateText("The quick brown fox jumps over the lazy dog", 20);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(21);
    expect(result).not.toContain(" …");
  });

  it("does not leave a trailing separator before the ellipsis", () => {
    const result = truncateText("One, two, three, four, five, six, seven", 12);
    expect(result.endsWith("…")).toBe(true);
    expect(/[\s,;:—–-]…$/.test(result)).toBe(false);
  });
});

describe("getFirstSentence", () => {
  it("stops at the first sentence-ending punctuation", () => {
    expect(getFirstSentence("First sentence. Second sentence.")).toBe("First sentence.");
  });

  it("stops at the first newline even without punctuation", () => {
    expect(getFirstSentence("Headline without punctuation\nBody text follows")).toBe("Headline without punctuation");
  });

  it("returns the whole trimmed text when there is only one sentence and no newline", () => {
    expect(getFirstSentence("  Just one sentence with no ending punctuation  ")).toBe("Just one sentence with no ending punctuation");
  });

  it("returns an empty string for empty input", () => {
    expect(getFirstSentence("")).toBe("");
  });
});
