import { describe, expect, it } from "bun:test";
import { keyEntities } from "./key-entities";

describe("keyEntities", () => {
  it("collapses case variants of one entity into a single canonical name", () => {
    // The regex matches case-insensitively; deduping on the raw match used to
    // emit "AI" and "ai" as two separate entities for the same post.
    expect(keyEntities("ai and AI and Ai, plus claude and Claude")).toEqual(["AI", "Claude"]);
  });

  it("keeps the canonical spelling regardless of how a post wrote it", () => {
    expect(keyEntities("openai shipped codex; anthropic shipped claude code")).toEqual(["OpenAI", "Codex", "Anthropic", "Claude Code"]);
  });

  it("reads through markup and returns nothing when no entity is named", () => {
    expect(keyEntities("<p>Docker</p> and&nbsp;Bun")).toEqual(["Docker", "Bun"]);
    expect(keyEntities("just a regular update")).toEqual([]);
  });

  it("bounds the list", () => {
    expect(keyEntities("AI API LLM Codex Gemini Google", 3)).toEqual(["AI", "API", "LLM"]);
  });
});
