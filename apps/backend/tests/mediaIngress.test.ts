import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { type BackendConfig, loadConfig } from "../src/foundation/config.js";
import { importTelegramAlbumMedia } from "../src/interfaces/telegram/media-ingress.js";
import { openBackendDb } from "./helpers/open-db.js";

function botWith(getFile: (fileId: string) => Promise<{ file_path?: string }>): Bot {
  return { api: { getFile } } as unknown as Bot;
}

/** Every case needs the same throwaway media dir + in-memory db + config, so the
 * bodies below can stay about the ingress behaviour they actually assert. */
function withIngress<T>(
  fn: (context: { dir: string; backendDb: ReturnType<typeof openBackendDb>; config: BackendConfig }) => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-ingress-"));
  const backendDb = openBackendDb(":memory:");
  const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir, ...env });
  return fn({ dir, backendDb, config }).finally(() => {
    backendDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

describe("importTelegramAlbumMedia", () => {
  it("leaves items that already carry an asset_id or local_path untouched", async () => {
    await withIngress(async ({ backendDb, config }) => {
      const bot = botWith(async () => {
        throw new Error("getFile should not be called for an already-imported item");
      });
      const media = [{ type: "photo", asset_id: 42, local_path: "/already/imported.jpg" }];
      const result = await importTelegramAlbumMedia(bot, backendDb, config, 1, media);
      expect(result).toEqual(media);
    });
  });

  it("rejects an item with no file id", async () => {
    await withIngress(async ({ backendDb, config }) => {
      const bot = botWith(async () => ({ file_path: "photos/1.jpg" }));
      await expect(importTelegramAlbumMedia(bot, backendDb, config, 1, [{ type: "photo" }])).rejects.toThrow(
        "Telegram media item has no file id.",
      );
    });
  });

  it("rejects when Telegram returns no file path", async () => {
    await withIngress(async ({ backendDb, config }) => {
      const bot = botWith(async () => ({}));
      await expect(importTelegramAlbumMedia(bot, backendDb, config, 1, [{ type: "photo", file_id: "abc" }])).rejects.toThrow(
        "Telegram did not return a media file path.",
      );
    });
  });

  it("imports each album item, tagging it with the resulting asset", async () => {
    await withIngress(async ({ dir, backendDb, config }) => {
      const photoSource = path.join(dir, "photo.jpg");
      const videoSource = path.join(dir, "video.mp4");
      fs.writeFileSync(photoSource, Buffer.from("fake jpg bytes"));
      fs.writeFileSync(videoSource, Buffer.from("fake mp4 bytes"));
      const bot = botWith(async (fileId: string) => ({ file_path: fileId === "photo-1" ? photoSource : videoSource }));

      const result = await importTelegramAlbumMedia(bot, backendDb, config, 9, [
        { type: "photo", file_id: "photo-1" },
        { type: "video", file_id: "video-1" },
      ]);

      expect(result).toHaveLength(2);
      for (const item of result) {
        expect(item.asset_id).toBeGreaterThan(0);
        expect(fs.existsSync(String(item.local_path))).toBe(true);
      }
      expect(result[0]?.mime_type).toBe("image/jpeg");
      expect(result[1]?.mime_type).toBe("video/mp4");
    });
  });

  it("downloads a remote Telegram file_path before importing it", async () => {
    await withIngress(
      async ({ backendDb, config }) => {
        const originalFetch = globalThis.fetch;
        const requestedUrls: string[] = [];
        globalThis.fetch = (async (input: string | URL | Request) => {
          requestedUrls.push(String(input));
          return new Response(Buffer.from("remote jpg bytes"), { status: 200 });
        }) as typeof fetch;
        try {
          const bot = botWith(async () => ({ file_path: "photos/remote.jpg" }));
          const result = await importTelegramAlbumMedia(bot, backendDb, config, 1, [{ type: "photo", file_id: "remote-1" }]);
          expect(result[0]?.asset_id).toBeGreaterThan(0);
          expect(requestedUrls).toEqual(["https://telegram.local/file/bottoken/photos/remote.jpg"]);
        } finally {
          globalThis.fetch = originalFetch;
        }
      },
      { TELEGRAM_API_BASE_URL: "https://telegram.local" },
    );
  });
});
