import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { publishInstagramStory } from "../src/social/instagram.js";
import { publishTelegramStory } from "../src/social/telegramStories.js";
import { generateStoryMedia } from "../src/media/story.js";

describe("story publishers", () => {
  it("generates a 1080x1920 story-safe image with ffmpeg", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-image-"));
    const source = path.join(dir, "source.png");
    fs.writeFileSync(source, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    try {
      const generated = await generateStoryMedia([{ type: "photo", local_path: source }], 1, "ru", loadConfig({ DATA_DIR: dir }));
      expect(generated[0]).toMatchObject({ story_width: 1080, story_height: 1920 });
      expect(fs.existsSync(String(generated[0]?.story_local_path))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates, waits for and publishes an Instagram story", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      { id: "container-1" },
      { status_code: "FINISHED" },
      { id: "story-1" },
      { permalink: "https://instagram.com/stories/a/1" },
    ];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    }) as unknown as typeof fetch;
    const config = loadConfig({
      ENABLE_INSTAGRAM_STORIES: "true",
      INSTAGRAM_ACCESS_TOKEN: "IG-token",
      INSTAGRAM_USER_ID: "ig-user",
    });

    const result = await publishInstagramStory({ text: "Story caption", media: [{ type: "IMAGE", vps_url: "https://example.com/story.jpg" }] }, config, fetchImpl);

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

  it("posts a photo story through a Telegram business connection", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-"));
    const imagePath = path.join(dir, "story.jpg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const backendDb = openBackendDb(":memory:");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ ok: true, result: { id: 77 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const config = loadConfig({
        ENABLE_TELEGRAM_STORIES: "true",
        TELEGRAM_STORIES_BOT_TOKEN: "bot-token",
        TELEGRAM_STORIES_BUSINESS_CONNECTION_ID: "business-1",
        TELEGRAM_API_BASE_URL: "https://telegram.local",
      });
      const result = await publishTelegramStory({ text: "Read https://alexgetman.com/1/post/", media: [{ type: "IMAGE", local_path: imagePath }] }, config, backendDb, fetchImpl);

      expect(result).toMatchObject({ ok: true, id: 77 });
      expect(calls[0]?.url).toBe("https://telegram.local/botbot-token/postStory");
      expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
      const form = calls[0]?.init?.body as FormData;
      expect(form.get("business_connection_id")).toBe("business-1");
      expect(form.get("content")).toBe(JSON.stringify({ type: "photo", photo: "attach://story" }));
      expect(form.get("areas")).toContain("https://alexgetman.com/1/post/");
    } finally {
      backendDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the Bot API when the configured MTProto session is a legacy file path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-legacy-"));
    const imagePath = path.join(dir, "story.jpg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const backendDb = openBackendDb(":memory:");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { id: 88 } }), { status: 200 })) as unknown as typeof fetch;
    try {
      const config = loadConfig({
        ENABLE_TELEGRAM_STORIES: "true",
        TELEGRAM_STORIES_BOT_TOKEN: "bot-token",
        TELEGRAM_STORIES_BUSINESS_CONNECTION_ID: "business-1",
        TELEGRAM_CHANNEL_STORIES_API_ID: "123",
        TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
        TELEGRAM_CHANNEL_STORIES_SESSION: "/data/telegram_channel_stories.session",
        TELEGRAM_API_BASE_URL: "https://telegram.local",
      });
      const result = await publishTelegramStory({ text: "Story", media: [{ type: "IMAGE", local_path: imagePath }] }, config, backendDb, fetchImpl);
      expect(result).toMatchObject({ ok: true, id: 88 });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      backendDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
