import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishInstagramStory } from "../src/delivery/social/instagram.js";
import { telegramStoryCaption, telegramStoryUploadMedia } from "../src/delivery/social/telegramStories.js";
import { generateStoryMedia } from "../src/delivery/story-media.js";
import { loadConfig } from "../src/foundation/config.js";
import { createChannelStoryClient } from "../src/foundation/external/telegram-session.js";

const ffmpegCalls: string[][] = [];

mock.module("../src/foundation/runtime/ffmpeg.js", () => {
  return {
    runFfmpeg: async (args: string[]) => {
      ffmpegCalls.push(args);
      const outputPath = args.at(-1);
      if (!outputPath) throw new Error("ffmpeg output path is missing");
      fs.writeFileSync(outputPath, "fake story image content");
    },
  };
});

describe("story publishers", () => {
  it("generates a 1080x1920 story-safe image with ffmpeg", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-image-"));
    const source = path.join(dir, "source.png");
    fs.writeFileSync(
      source,
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    );
    try {
      const generated = await generateStoryMedia([{ type: "photo", local_path: source }], 1, "ru", loadConfig({ DATA_DIR: dir }));
      expect(generated[0]).toMatchObject({ story_width: 1080, story_height: 1920 });
      expect(fs.existsSync(String(generated[0]?.story_local_path))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("letterboxes video into the shared 1080x1920 50 FPS H.264 Story master", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-video-"));
    const source = path.join(dir, "source.mp4");
    fs.writeFileSync(source, "fake video");
    try {
      const generated = await generateStoryMedia([{ type: "video", local_path: source }], 2, "en", loadConfig({ DATA_DIR: dir }));
      expect(generated[0]).toMatchObject({ story_width: 1080, story_height: 1920 });
      expect(String(generated[0]?.story_local_path)).toEndWith(".mp4");
      expect(fs.existsSync(String(generated[0]?.story_local_path))).toBe(true);
      const ffmpegArgs = ffmpegCalls.at(-1) ?? [];
      expect(ffmpegArgs[ffmpegArgs.indexOf("-t") + 1]).toBe("59");
      expect(ffmpegArgs.slice(ffmpegArgs.indexOf("-r"), ffmpegArgs.indexOf("-r") + 2)).toEqual(["-r", "50"]);
      expect(ffmpegArgs.slice(ffmpegArgs.indexOf("-c:v"), ffmpegArgs.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
      expect(ffmpegArgs.slice(ffmpegArgs.indexOf("-b:a"), ffmpegArgs.indexOf("-b:a") + 2)).toEqual(["-b:a", "320k"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uploads generated story paths as files, rather than treating them as Telegram file IDs", () => {
    expect(telegramStoryUploadMedia("/data/story-media/draft-59-ru.jpg", "IMAGE")).toEqual({
      type: "photo",
      file: "file:/data/story-media/draft-59-ru.jpg",
    });
    expect(telegramStoryUploadMedia("/data/story-media/draft-59-en.mp4", "VIDEO")).toEqual({
      type: "video",
      file: "file:/data/story-media/draft-59-en.mp4",
    });
  });

  it("removes links from Telegram Story captions", () => {
    expect(telegramStoryCaption("Read more: https://alexgetman.com/post/59\n\n\nThank you")).toBe("Read more:\n\nThank you");
  });

  it("creates, waits for and publishes an Instagram story", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { id: "container-1" },
      { status_code: "FINISHED" },
      { id: "story-1" },
      { permalink: "https://instagram.com/stories/a/1" },
    ];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadConfig({
      ENABLE_INSTAGRAM_STORIES: "true",
      INSTAGRAM_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_USER_ID: "ig-user",
    });

    const result = await publishInstagramStory(
      { text: "Story caption", media: [{ type: "IMAGE", vps_url: "https://example.com/story.jpg" }] },
      config,
      fetchImpl,
    );

    expect(result).toMatchObject({ ok: true, id: "story-1", url: "https://instagram.com/stories/a/1" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://graph.instagram.com/v23.0/ig-user/media",
      expect.stringContaining("https://graph.instagram.com/v23.0/container-1?"),
      "https://graph.instagram.com/v23.0/ig-user/media_publish",
      expect.stringContaining("https://graph.instagram.com/v23.0/story-1?"),
    ]);
    expect(String(requests[0]?.init?.body)).toContain("media_type=STORIES");
    expect(String(requests[0]?.init?.body)).toContain("image_url=https%3A%2F%2Fexample.com%2Fstory.jpg");
  });

  it("rejects a personal Telegram business story configuration before publishing", () => {
    expect(() =>
      loadConfig({
        ENABLE_TELEGRAM_STORIES: "true",
      }),
    ).toThrow("TELEGRAM_STORIES_CHANNEL is required");
  });

  it("requires an explicit channel identity for Telegram stories", () => {
    expect(() =>
      loadConfig({
        ENABLE_TELEGRAM_STORIES: "true",
        TELEGRAM_CHANNEL_STORIES_API_ID: "1",
        TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
        TELEGRAM_CHANNEL_STORIES_SESSION: "session",
      }),
    ).toThrow("TELEGRAM_STORIES_CHANNEL is required");
  });

  it("uses an mtcute SQLite session path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-legacy-"));
    try {
      const client = createChannelStoryClient(
        loadConfig({
          TELEGRAM_CHANNEL_STORIES_API_ID: "1",
          TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
          TELEGRAM_CHANNEL_STORIES_SESSION: path.join(dir, "mtcute.sqlite"),
        }),
      );
      expect(client).toBeTruthy();
      await client.destroy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
