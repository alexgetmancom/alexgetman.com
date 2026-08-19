import { describe, expect, it } from "bun:test";
import { registerChannel } from "../src/channels/registry.js";
import { translateDraftText } from "../src/content/translation.js";
import { openBackendDb } from "../src/db/client.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("draft translation", () => {
  it("produces no translation when the provider is unavailable", async () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "en", provider: "native", targetId: "threads_en" });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("provider unavailable"))) as unknown as typeof fetch;
    try {
      // It used to answer with the Russian text it was handed, which is the one
      // answer that cannot be told apart from a real translation: the draft
      // looked finished and the English channels published Russian.
      expect(await translateDraftText(backendDb, "Русский текст", loadTestConfig({ DEEPSEEK_API_KEY: "test-key" }))).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
      backendDb.close();
    }
  });

  it("never calls the translator for a Studio that publishes no English", async () => {
    const backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, { platform: "threads", locale: "ru", provider: "native", targetId: "threads_ru" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("must not be called"));
    }) as unknown as typeof fetch;
    try {
      expect(await translateDraftText(backendDb, "Русский текст", loadTestConfig({ DEEPSEEK_API_KEY: "test-key" }))).toBeUndefined();
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      backendDb.close();
    }
  });
});
