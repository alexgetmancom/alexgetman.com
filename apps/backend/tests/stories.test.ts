import { describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { needsVerticalBlur, remoteStoryFfmpegArgs } from "../../../deploy/media-processor/story-encode.js";
import { publishInstagramStory } from "../src/delivery/social/instagram.js";
import { InstagramContainerInvalidError } from "../src/delivery/social/instagram-container.js";
import { telegramStoryCaption, telegramStoryCaptionInput, telegramStoryUploadMedia } from "../src/delivery/social/telegramStories.js";
import { generateStoryMedia } from "../src/delivery/story-media.js";
import { loadConfig } from "../src/foundation/config.js";

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

  it("letterboxes video into a 1080x1920 H.264 Story master without changing source FPS", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-video-"));
    const source = path.join(dir, "source.mp4");
    fs.writeFileSync(source, "fake video");
    try {
      const generated = await generateStoryMedia([{ type: "video", local_path: source }], 2, "en", loadConfig({ DATA_DIR: dir }));
      expect(generated[0]).toMatchObject({ story_width: 1080, story_height: 1920 });
      expect(String(generated[0]?.story_local_path)).toEndWith(".mp4");
      expect(fs.existsSync(String(generated[0]?.story_local_path))).toBe(true);
      const ffmpegArgs = ffmpegCalls.at(-1) ?? [];
      expect(ffmpegArgs[ffmpegArgs.indexOf("-t") + 1]).toBe("58.9");
      expect(ffmpegArgs).not.toContain("-r");
      expect(ffmpegArgs.slice(ffmpegArgs.indexOf("-c:v"), ffmpegArgs.indexOf("-c:v") + 2)).toEqual(["-c:v", "libx264"]);
      expect(ffmpegArgs.slice(ffmpegArgs.indexOf("-b:a"), ffmpegArgs.indexOf("-b:a") + 2)).toEqual(["-b:a", "320k"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses VAAPI only in the remote worker recipe", () => {
    const args = remoteStoryFfmpegArgs("source.mp4", "standard.mp4", "telegram.mp4", 1100, true);
    expect(args.slice(0, 4)).toEqual(["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va"]);
    expect(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2)).toEqual(["-c:v", "h264_vaapi"]);
    expect(args[args.indexOf("-filter_complex") + 1]).toContain("format=nv12,hwupload,split=2");
    expect(args[args.indexOf("-filter_complex") + 1]).not.toContain("fps=50");
    expect(args.filter((arg) => arg === "h264_vaapi")).toHaveLength(2);
    expect(args.filter((arg) => arg === "-t")).toHaveLength(2);
    expect(args[args.indexOf("standard.mp4") - 2]).toBe("-t");
    expect(args[args.indexOf("standard.mp4") - 1]).toBe("58.9");
    expect(args[args.indexOf("telegram.mp4") - 2]).toBe("-t");
    expect(args[args.indexOf("telegram.mp4") - 1]).toBe("58.9");
    expect(args).toContain("telegram.mp4");
  });

  it("keeps near-9:16 media plain and adds blur beyond the five-percent tolerance", () => {
    expect(needsVerticalBlur(1080, 1920)).toBe(false);
    expect(needsVerticalBlur(1080, 1830)).toBe(false);
    expect(needsVerticalBlur(1080, 1600)).toBe(true);
    expect(needsVerticalBlur(720, 1600)).toBe(true);
  });

  it("uploads generated story paths as files, rather than treating them as Telegram file IDs", () => {
    expect(telegramStoryUploadMedia("/data/story-media/draft-59-ru.jpg", "IMAGE", { width: 0, height: 0, duration: 0 })).toEqual({
      type: "photo",
      file: "file:/data/story-media/draft-59-ru.jpg",
    });
    expect(telegramStoryUploadMedia("/data/story-media/draft-59-en.mp4", "VIDEO", { width: 1080, height: 1920, duration: 59 })).toEqual({
      type: "video",
      file: "file:/data/story-media/draft-59-en.mp4",
      width: 1080,
      height: 1920,
      duration: 59,
      supportsStreaming: true,
    });
  });

  it("removes links from Telegram Story captions", () => {
    expect(telegramStoryCaption("Read more: https://alexgetman.com/post/59\n\n\nThank you")).toBe("Read more:\n\nThank you");
  });

  it("keeps a hidden Telegram link clickable in a Story caption", () => {
    expect(
      telegramStoryCaptionInput("Read guide", [{ type: "text_link", offset: 5, length: 5, url: "https://example.com/guide" }]),
    ).toEqual({
      text: "Read guide",
      entities: [{ _: "messageEntityTextUrl", offset: 5, length: 5, url: "https://example.com/guide" }],
    });
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

  it("recreates an Instagram Story container that reaches ERROR before publication", async () => {
    const requests: string[] = [];
    const responses = [
      { id: "container-bad" },
      { status_code: "ERROR", status: "upload failed" },
      null,
      { id: "container-good" },
      { status_code: "FINISHED" },
      { id: "story-2" },
      { permalink: "https://instagram.com/stories/a/2" },
    ];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(String(input));
      if (init?.method === "HEAD") {
        responses.shift();
        return new Response(null, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": "1234" },
        });
      }
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadConfig({
      ENABLE_INSTAGRAM_STORIES: "true",
      INSTAGRAM_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_USER_ID: "ig-user",
    });

    const result = await publishInstagramStory({ media: [{ type: "IMAGE", vps_url: "https://example.com/story.jpg" }] }, config, fetchImpl);

    expect(result).toMatchObject({ ok: true, id: "story-2" });
    expect(requests.filter((url) => url.endsWith("/ig-user/media"))).toHaveLength(2);
    expect(requests).toContain("https://example.com/story.jpg");
  }, 10_000);

  it("includes public media diagnostics when Instagram rejects both containers", async () => {
    const responses = [
      { id: "container-1" },
      { status_code: "ERROR", status: "upload failed" },
      { id: "container-2" },
      { status_code: "ERROR", status: "upload failed again" },
    ];
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Content-Length": "4321" },
        });
      }
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadConfig({
      ENABLE_INSTAGRAM_STORIES: "true",
      INSTAGRAM_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_USER_ID: "ig-user",
    });

    const failure = await publishInstagramStory(
      { media: [{ type: "IMAGE", vps_url: "https://example.com/story.jpg" }] },
      config,
      fetchImpl,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InstagramContainerInvalidError);
    expect(String(failure)).toContain('"containerId":"container-2"');
    expect(String(failure)).toContain('"providerStatus":"upload failed again"');
    expect(String(failure)).toContain('"contentType":"image/jpeg"');
    expect(String(failure)).toContain('"contentLength":"4321"');
  }, 10_000);

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
});
