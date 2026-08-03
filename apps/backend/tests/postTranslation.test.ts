import { describe, expect, it } from "bun:test";
import { translatePostText } from "../src/bot/post-translation.js";
import { loadConfig } from "../src/foundation/config.js";

describe("post translation fallback", () => {
  it("keeps the source text when the translation provider is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("provider unavailable"))) as unknown as typeof fetch;
    try {
      const result = await translatePostText("Русский текст", loadConfig({ DEEPSEEK_API_KEY: "test-key" }));
      expect(result).toBe("Русский текст");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
