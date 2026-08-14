import { describe, expect, it } from "bun:test";
import { translatePostText } from "../src/bot/post-translation.js";
import { loadConfig } from "../src/foundation/config.js";

describe("post translation fallback", () => {
  it("produces no translation when the provider is unavailable", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("provider unavailable"))) as unknown as typeof fetch;
    try {
      // It used to answer with the Russian text it was handed, which is the one
      // answer that cannot be told apart from a real translation: the draft
      // looked finished and the English channels published Russian.
      expect(await translatePostText("Русский текст", loadConfig({ DEEPSEEK_API_KEY: "test-key" }))).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
