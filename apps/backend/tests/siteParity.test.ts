import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDraftFromMessage, publishDraftToQueue } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { publishContentIndex } from "../src/site/contentIndex.js";
import { pingIndexNow } from "../src/site/indexNow.js";

describe("site parity", () => {
  it("publishes content memory and deduplicates IndexNow submissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-site-parity-"));
    const backendDb = openBackendDb(join(dir, "pipeline.db"));
    const config = loadConfig({ DATA_DIR: dir, SITE_PUBLIC_DIR: dir, PUBLIC_BASE_URL: "https://example.test", INDEXNOW_ENABLED: "true" });
    try {
      const draft = createDraftFromMessage(backendDb, 1, { text: "Русский заголовок", textEn: "English title", media: [], entities: [] });
      publishDraftToQueue(backendDb, draft);
      const urls = publishContentIndex(config, backendDb);
      expect(existsSync(join(dir, "content-index.json"))).toBe(true);
      expect(readFileSync(join(dir, "content-memory.md"), "utf8")).toContain("English title");
      const fetchImpl = vi.fn(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
      await pingIndexNow(config, urls, fetchImpl);
      await pingIndexNow(config, urls, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(existsSync(join(dir, "indexnow.json"))).toBe(true);
    } finally {
      backendDb.close();
    }
  });
});
