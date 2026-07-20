import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "grammy";
import { openBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { StudioError } from "../src/foundation/errors.js";
import { storeTelegramVideo } from "../src/interfaces/telegram/video-ingress.js";

/** Synthetic grammY context: only the shape storeTelegramVideo actually reads. */
function contextWith(message: Record<string, unknown>, getFile: (fileId: string) => Promise<{ file_path?: string }>): Context {
  return { message, api: { getFile } } as unknown as Context;
}

function withMediaDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-video-ingress-"));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe("storeTelegramVideo", () => {
  it("rejects a message with neither a video nor a document", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const ctx = contextWith({ text: "hello" }, async () => ({ file_path: "video.mp4" }));
        await expect(storeTelegramVideo(ctx, backendDb, config, 1)).rejects.toThrow(StudioError);
        await expect(storeTelegramVideo(ctx, backendDb, config, 1)).rejects.toMatchObject({ code: "err.send-mp4" });
      } finally {
        backendDb.close();
      }
    });
  });

  it("rejects a document that is neither video/* nor named .mp4", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const ctx = contextWith({ document: { file_id: "doc-1", mime_type: "application/pdf", file_name: "report.pdf" } }, async () => ({
          file_path: "docs/report.pdf",
        }));
        await expect(storeTelegramVideo(ctx, backendDb, config, 1)).rejects.toMatchObject({ code: "err.only-video" });
      } finally {
        backendDb.close();
      }
    });
  });

  it("imports an uploaded video whose Telegram file_path is already a local absolute path", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ CONTROLLER_BOT_TOKEN: "token", STUDIO_MEDIA_DIR: dir });
      try {
        const sourceFile = path.join(dir, "source.mp4");
        fs.writeFileSync(sourceFile, Buffer.from("fake mp4 bytes"));
        const ctx = contextWith({ video: { file_id: "vid-1" } }, async () => ({ file_path: sourceFile }));

        const result = await storeTelegramVideo(ctx, backendDb, config, 7);

        expect(result.assetId).toBeGreaterThan(0);
        expect(fs.existsSync(sourceFile)).toBe(true); // an already-local path is never deleted as temporary
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
        return new Response(Buffer.from("remote mp4 bytes"), { status: 200 });
      }) as typeof fetch;
      try {
        const ctx = contextWith({ document: { file_id: "doc-2", file_name: "clip.mp4" } }, async () => ({ file_path: "videos/clip.mp4" }));

        const result = await storeTelegramVideo(ctx, backendDb, config, 3);

        expect(result.assetId).toBeGreaterThan(0);
        expect(requestedUrls).toEqual(["https://telegram.local/file/bottoken/videos/clip.mp4"]);
      } finally {
        globalThis.fetch = originalFetch;
        backendDb.close();
      }
    });
  });

  it("rejects when the bot token is not configured", async () => {
    await withMediaDir(async (dir) => {
      const backendDb = openBackendDb(":memory:");
      const config = loadConfig({ STUDIO_MEDIA_DIR: dir });
      try {
        const ctx = contextWith({ video: { file_id: "vid-1" } }, async () => ({ file_path: "video.mp4" }));
        await expect(storeTelegramVideo(ctx, backendDb, config, 1)).rejects.toThrow("Telegram bot token is not configured.");
      } finally {
        backendDb.close();
      }
    });
  });
});
