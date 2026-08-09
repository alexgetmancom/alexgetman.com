import { describe, expect, it } from "bun:test";
import {
  publishTelegramStory,
  telegramStoryCaption,
  telegramStoryCaptionInput,
  telegramStoryUploadMedia,
} from "../src/delivery/social/telegramStories.js";
import { loadConfig } from "../src/foundation/config.js";

/** Everything a channel story needs except the one field under test. Reaching
 * MTProto from a test is not possible, so these cases pin the guard ladder that
 * decides whether the client is created at all — the part that runs on every
 * publish and whose wrong answer is either a silent skip or a live connection
 * attempt with half a configuration. */
const storyEnv = {
  CONTROLLER_ADMIN_IDS: "42",
  CONTROLLER_BOT_TOKEN: "token",
  TELEGRAM_STORIES_CHANNEL: "@alexgetman",
  TELEGRAM_CHANNEL_STORIES_API_ID: "1",
  TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
  TELEGRAM_CHANNEL_STORIES_SESSION: "session",
};

// payloadMedia drops a record that has only a story path, so the shape here is
// the one generateStoryMedia actually produces: the original item plus the
// generated story variant.
const payload = {
  text: "A story",
  media: [{ type: "photo", localPath: "/tmp/source.jpg", storyLocalPath: "/tmp/story.jpg" }],
};

describe("publishTelegramStory guards", () => {
  it("skips without media rather than connecting to Telegram", async () => {
    expect(await publishTelegramStory({ text: "No media" }, loadConfig(storyEnv))).toEqual({
      ok: false,
      skipped: true,
      reason: "missing_media",
    });
  });

  it("skips media that carries neither a story path nor a local path", async () => {
    const remoteOnly = { text: "t", media: [{ type: "photo", vpsUrl: "https://cdn.test/a.jpg" }] };

    expect(await publishTelegramStory(remoteOnly, loadConfig(storyEnv))).toMatchObject({ skipped: true, reason: "missing_media" });
  });

  it("skips on a partial MTProto session instead of attempting a connection", async () => {
    // loadConfig already refuses to start with Stories enabled and credentials
    // half-filled, so these two guards only fire on a config assembled some
    // other way. They stay worth pinning: without them the publisher would open
    // a live socket that cannot authenticate and burn the job's whole timeout.
    for (const missing of [
      "TELEGRAM_CHANNEL_STORIES_API_ID",
      "TELEGRAM_CHANNEL_STORIES_API_HASH",
      "TELEGRAM_CHANNEL_STORIES_SESSION",
    ] as const) {
      const config = { ...loadConfig(storyEnv), [missing]: undefined } as ReturnType<typeof loadConfig>;

      expect(await publishTelegramStory(payload, config)).toMatchObject({
        skipped: true,
        reason: "missing_channel_story_credentials",
      });
    }
  });

  it("skips when no story channel is named", async () => {
    const config = { ...loadConfig(storyEnv), TELEGRAM_STORIES_CHANNEL: "" } as ReturnType<typeof loadConfig>;

    expect(await publishTelegramStory(payload, config)).toMatchObject({ skipped: true, reason: "missing_story_channel" });
  });

  it("reports every guard as skipped rather than failed, so the queue does not retry it", async () => {
    const results = [
      await publishTelegramStory({ text: "t" }, loadConfig(storyEnv)),
      await publishTelegramStory(payload, loadConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "token" })),
    ];

    for (const result of results) expect(result).toMatchObject({ ok: false, skipped: true });
  });
});

describe("telegramStoryUploadMedia", () => {
  const metadata = { width: 1080, height: 1920, duration: 15 };

  it("declares the video dimensions Telegram validates", () => {
    // mtcute defaults all three to 0, which stories.sendStory rejects with
    // MEDIA_FILE_INVALID — the same generic error an unsupported codec produces.
    expect(telegramStoryUploadMedia("/tmp/story.mp4", "VIDEO", metadata)).toEqual({
      type: "video",
      file: "file:/tmp/story.mp4",
      width: 1080,
      height: 1920,
      duration: 15,
      supportsStreaming: true,
    });
  });

  it("marks the path as a local upload rather than a Telegram file id", () => {
    // A bare string is read by mtcute as a Bot API file ID; the generated file
    // would never be uploaded.
    expect(telegramStoryUploadMedia("/tmp/story.jpg", "IMAGE", metadata)).toEqual({ type: "photo", file: "file:/tmp/story.jpg" });
  });
});

describe("telegramStoryCaption", () => {
  it("strips links, collapses the blank lines they leave behind and caps the length", () => {
    expect(telegramStoryCaption("Read https://example.com/a now")).toBe("Read  now");
    expect(telegramStoryCaption("One   \nTwo")).toBe("One\nTwo");
    expect(telegramStoryCaption("One\n\n\n\nTwo")).toBe("One\n\nTwo");
    expect(telegramStoryCaption("x".repeat(3_000))).toHaveLength(2_048);
  });
});

describe("telegramStoryCaptionInput", () => {
  it("keeps a hidden link clickable when the visible text did not change", () => {
    const text = "Read the announcement";
    const entities = [{ type: "text_link", offset: 5, length: 3, url: "https://example.com" }];

    expect(telegramStoryCaptionInput(text, entities)).toEqual({
      text,
      entities: [{ _: "messageEntityTextUrl", offset: 5, length: 3, url: "https://example.com" }],
    });
  });

  it("drops entities once URL removal has shifted the offsets", () => {
    // Keeping them would attach the link to whatever text moved into that range.
    const result = telegramStoryCaptionInput("Read https://example.com now", [
      { type: "text_link", offset: 0, length: 4, url: "https://example.com" },
    ]);

    expect(result).toBe("Read  now");
  });

  it("ignores an entity that is not a hidden link", () => {
    expect(telegramStoryCaptionInput("Bold text", [{ type: "bold", offset: 0, length: 4 }])).toBe("Bold text");
    expect(telegramStoryCaptionInput("No url field", [{ type: "text_link", offset: 0, length: 2 }])).toBe("No url field");
  });

  it("rejects a range that falls outside the caption", () => {
    // An out-of-range entity makes Telegram reject the whole story.
    for (const entity of [
      { type: "text_link", offset: 0, length: 999, url: "https://example.com" },
      { type: "text_link", offset: -1, length: 2, url: "https://example.com" },
      { type: "text_link", offset: 0, length: 0, url: "https://example.com" },
      { type: "text_link", offset: Number.NaN, length: 2, url: "https://example.com" },
    ])
      expect(telegramStoryCaptionInput("Short text", [entity])).toBe("Short text");
  });

  it("survives a malformed entity list", () => {
    expect(telegramStoryCaptionInput("Text", [null, undefined, "nonsense", []])).toBe("Text");
  });
});
