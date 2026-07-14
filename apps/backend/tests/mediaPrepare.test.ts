import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { prepareMediaItems, pruneMediaCache } from "../src/delivery/media-prepare.js";

describe("media preparation", () => {
  it("reuses durable local and public files for identical target uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-race-"));
    const config = loadConfig({
      CONTROLLER_BOT_TOKEN: "token",
      TELEGRAM_API_BASE_URL: "https://telegram.local",
      MEDIA_CACHE_DIR: path.join(dir, "cache"),
      REMOTE_MEDIA_PATH: path.join(dir, "public"),
      PUBLIC_MEDIA_BASE_URL: "https://example.com/media",
    });
    const fetchImpl = mock(async (input: string | URL | Request) =>
      String(input).includes("getFile")
        ? new Response(JSON.stringify({ ok: true, result: { file_path: "photos/source.jpg" } }), { status: 200 })
        : new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200 }),
    ) as unknown as typeof fetch;
    try {
      const source = [{ type: "IMAGE" as const, fileId: "same-file-id" }];
      const [first, second] = await Promise.all([
        prepareMediaItems(config, source, fetchImpl),
        prepareMediaItems(config, source, fetchImpl),
      ]);
      expect(first.items[0]?.localPath).toBe(second.items[0]?.localPath);
      expect(first.items[0]?.vpsUrl).toBe(second.items[0]?.vpsUrl);
      expect(fs.existsSync(String(first.items[0]?.localPath))).toBe(true);
      await first.cleanup();
      expect(fs.existsSync(String(second.items[0]?.localPath))).toBe(true);
      await second.cleanup();
      expect(fs.existsSync(String(second.items[0]?.vpsUrl).replace("https://example.com/media/", path.join(dir, "public/")))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prunes only expired managed cache files", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-prune-"));
    try {
      const config = loadConfig({
        MEDIA_CACHE_DIR: path.join(dir, "cache"),
        REMOTE_MEDIA_PATH: path.join(dir, "public"),
        MEDIA_CACHE_TTL_SECONDS: "1",
      });
      fs.mkdirSync(config.MEDIA_CACHE_DIR, { recursive: true });
      fs.mkdirSync(config.REMOTE_MEDIA_PATH, { recursive: true });
      const cached = path.join(config.MEDIA_CACHE_DIR, "asset.jpg");
      const publicCached = path.join(config.REMOTE_MEDIA_PATH, "cache-asset.jpg");
      const unrelated = path.join(config.REMOTE_MEDIA_PATH, "editorial.jpg");
      for (const file of [cached, publicCached, unrelated]) fs.writeFileSync(file, "x");
      const old = new Date(Date.now() - 10_000);
      for (const file of [cached, publicCached, unrelated]) fs.utimesSync(file, old, old);
      expect(await pruneMediaCache(config)).toBe(2);
      expect(fs.existsSync(unrelated)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
