import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { prepareMediaItems } from "../src/media/prepare.js";

describe("media preparation", () => {
  it("uses unique local and public files for concurrent target uploads", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-race-"));
    const config = loadConfig({
      CONTROLLER_BOT_TOKEN: "token",
      TELEGRAM_API_BASE_URL: "https://telegram.local",
      TEMP_MEDIA_DIR: path.join(dir, "tmp"),
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
      expect(first.items[0]?.localPath).not.toBe(second.items[0]?.localPath);
      expect(first.items[0]?.vpsUrl).not.toBe(second.items[0]?.vpsUrl);
      expect(fs.existsSync(String(first.items[0]?.localPath))).toBe(true);
      expect(fs.existsSync(String(second.items[0]?.localPath))).toBe(true);
      await first.cleanup();
      expect(fs.existsSync(String(second.items[0]?.localPath))).toBe(true);
      await second.cleanup();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
