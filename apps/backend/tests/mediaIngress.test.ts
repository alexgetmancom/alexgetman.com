import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Bot } from "grammy";
import { openBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { importTelegramAlbumMedia } from "../src/interfaces/telegram/media-ingress.js";

function botWith(getFile: ((fileId: string) => Promise<{ file_path?: string }>) | undefined): Bot {
  return { api: { getFile } } as unknown as Bot;
}

function withMediaDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-media-ingress-"));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe("importTelegramAlbumMedia", () => {
  it("passes media through unchanged when the bot has no getFile (historical/test-only ingress)", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const media = [{ type: "photo", file_id: "abc" }];
        const result = await importTelegramAlbumMedia(botWith(undefined), backendDb, config, 1, media);
        expect(result).toEqual(media);
      } finally {
        backendDb.close();
      }
    });
  });

  it("leaves items that already carry an asset_id or local_path untouched", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const bot = botWith(async () => {
          throw new Error("getFile should not be called for an already-imported item");
        });
        const media = [{ type: "photo", asset_id: 42, local_path: "/already/imported.jpg" }];
        const result = await importTelegramAlbumMedia(bot, backendDb, config, 1, media);
        expect(result).toEqual(media);
      } finally {
        backendDb.close();
      }
    });
  });

  it("rejects an item with no file id", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const bot = botWith(async () => ({ file_path: "photos/1.jpg" }));
        await expect(importTelegramAlbumMedia(bot, backendDb, config, 1, [{ type: "photo" }])).rejects.toThrow(
          "Telegram media item has no file id.",
        );
      } finally {
        backendDb.close();
      }
    });
  });

  it("rejects when Telegram returns no file path", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const bot = botWith(async () => ({}));
        await expect(importTelegramAlbumMedia(bot, backendDb, config, 1, [{ type: "photo", file_id: "abc" }])).rejects.toThrow(
          "Telegram did not return a media file path.",
        );
      } finally {
        backendDb.close();
      }
    });
  });

  it("imports each album item, tagging it with the resulting asset", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
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
          expect(typeof item.local_path).toBe("string");
        }
        expect(result[0]?.mime_type).toBe("image/jpeg");
        expect(result[1]?.mime_type).toBe("video/mp4");
      } finally {
        backendDb.close();
      }
    });
  });

  it("downloads a remote Telegram file_path before importing it", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({
        CONTROLLER_BOT_TOKEN: "token",
        TELEGRAM_API_BASE_URL: "https://telegram.local",
        STUDIO_MEDIA_DIR: dir,
      });
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
        backendDb.close();
      }
    });
  });
});
