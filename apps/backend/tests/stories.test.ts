import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { generateStoryMedia } from "../src/media/story.js";
import { publishInstagramStory } from "../src/social/instagram.js";
import { loadChannelStorySession } from "../src/social/telegramSession.js";
import { publishTelegramStory } from "../src/social/telegramStories.js";

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

  it("never falls back to a personal Telegram business story", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-"));
    const imagePath = path.join(dir, "story.jpg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const backendDb = openBackendDb(":memory:");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    try {
      const config = loadConfig({
        ENABLE_TELEGRAM_STORIES: "true",
        TELEGRAM_STORIES_BOT_TOKEN: "bot-token",
        TELEGRAM_STORIES_BUSINESS_CONNECTION_ID: "business-1",
      });
      const result = await publishTelegramStory(
        { text: "Read https://alexgetman.com/1/post/", media: [{ type: "IMAGE", local_path: imagePath }] },
        config,
        backendDb,
        fetchImpl,
      );

      expect(result).toMatchObject({ skipped: true, reason: "missing_channel_story_credentials" });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      backendDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires an explicit channel identity for Telegram stories", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-"));
    const imagePath = path.join(dir, "story.jpg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({
        ENABLE_TELEGRAM_STORIES: "true",
        TELEGRAM_CHANNEL_STORIES_API_ID: "1",
        TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
        TELEGRAM_CHANNEL_STORIES_SESSION: "session",
      });
      await expect(publishTelegramStory({ media: [{ type: "IMAGE", local_path: imagePath }] }, config, backendDb)).resolves.toMatchObject({
        skipped: true,
        reason: "missing_story_channel",
      });
    } finally {
      backendDb.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("converts a Telethon SQLite session basename for GramJS", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-story-legacy-"));
    const imagePath = path.join(dir, "story.jpg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const sessionPath = path.join(dir, "telegram_channel_stories.session");
    const sqlite = new Database(sessionPath);
    sqlite.exec("CREATE TABLE sessions (dc_id INTEGER PRIMARY KEY, server_address TEXT, port INTEGER, auth_key BLOB, takeout_id INTEGER)");
    sqlite
      .prepare("INSERT INTO sessions(dc_id,server_address,port,auth_key) VALUES (?,?,?,?)")
      .run(2, "149.154.167.51", 443, Buffer.alloc(256, 7));
    sqlite.close();
    try {
      const session = loadChannelStorySession(path.join(dir, "telegram_channel_stories"));
      await session.load();
      expect(session.dcId).toBe(2);
      expect(session.serverAddress).toBe("149.154.167.51");
      expect(session.port).toBe(443);
      expect(session.authKey?.getKey()).toEqual(Buffer.alloc(256, 7));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
