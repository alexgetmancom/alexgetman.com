import { describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { openBackendDb } from "../src/db/client.js";
import { publishContentIndex } from "../src/delivery/site-content-index.js";
import { pingIndexNow } from "../src/delivery/site-index-now.js";
import { loadConfig } from "../src/foundation/config.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { reconcilePublication } from "../src/publishing/queue.js";

describe("site parity", () => {
  it("publishes content memory and deduplicates IndexNow submissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-site-parity-"));
    const backendDb = openBackendDb(join(dir, "pipeline.db"));
    const config = loadConfig({ DATA_DIR: dir, SITE_PUBLIC_DIR: dir, PUBLIC_BASE_URL: "https://example.test", INDEXNOW_ENABLED: "true" });
    try {
      const draft = createDraftFromMessage(backendDb, 1, { text: "Русский заголовок", textEn: "English title", media: [], entities: [] });
      const postId = publishDraftToQueue(backendDb, draft);
      backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=?").run(postId);
      backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE post_id=?").run(postId);
      reconcilePublication(backendDb, postId);
      const urls = publishContentIndex(config, backendDb);
      expect(existsSync(join(dir, "content-index.json"))).toBe(true);
      expect(readFileSync(join(dir, "content-memory.md"), "utf8")).toContain("English title");
      const fetchImpl = mock(async () => new Response("", { status: 202 })) as unknown as typeof fetch;
      await pingIndexNow(config, urls, fetchImpl);
      await pingIndexNow(config, urls, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(existsSync(join(dir, "indexnow.json"))).toBe(true);
    } finally {
      backendDb.close();
    }
  });

  it("retries an IndexNow batch after a rejected response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alexgetman-indexnow-"));
    const config = loadConfig({ DATA_DIR: dir, SITE_PUBLIC_DIR: dir, PUBLIC_BASE_URL: "https://example.test", INDEXNOW_ENABLED: "true" });
    const fetchImpl = mock(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(pingIndexNow(config, ["https://example.test/post"], fetchImpl)).rejects.toThrow("500");
    await expect(pingIndexNow(config, ["https://example.test/post"], fetchImpl)).rejects.toThrow("500");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
