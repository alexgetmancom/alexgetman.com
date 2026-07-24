import { afterEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishToBluesky } from "../src/delivery/social/bluesky.js";
import { payloadMedia, payloadText } from "../src/delivery/social/payload.js";
import { publishToTelegram } from "../src/delivery/social/telegram.js";
import { publishToThreads } from "../src/delivery/social/threads.js";
import { publishToX } from "../src/delivery/social/x.js";
import { loadConfig } from "../src/foundation/config.js";
import { oauthAuthorization } from "../src/foundation/external/x-oauth.js";

const tempDirs: string[] = [];

describe("publish payload validation", () => {
  it("drops malformed text and media values without throwing", () => {
    expect(payloadText({ text_en: 42 } as unknown as Record<string, unknown>)).toBe("");
    expect(payloadMedia({ media: [{ type: "video", local_path: 7 }, null, { type: "photo", file_id: "ok" }] })).toEqual([
      { type: "IMAGE", fileId: "ok" },
    ]);
  });

  it("uses Russian text and media for a Russian target payload even when legacy English fields remain", () => {
    const payload = {
      locale: "ru",
      text: "Русский текст",
      text_ru: "Русский текст",
      text_en: "English text",
      media: [{ type: "photo", file_id: "ru-image" }],
      media_en: [{ type: "photo", file_id: "en-image" }],
    };
    expect(payloadText(payload)).toBe("Русский текст");
    expect(payloadMedia(payload)).toEqual([{ type: "IMAGE", fileId: "ru-image" }]);
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Telegram publisher", () => {
  it("sends the Russian variant for a Russian payload even when English legacy fields are present", async () => {
    const fetchMock = mock(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    await publishToTelegram(
      {
        locale: "ru",
        text: "Русский текст",
        text_ru: "Русский текст",
        text_en: "English text",
        media: [{ type: "photo", file_id: "ru-image" }],
        media_en: [{ type: "photo", file_id: "en-image" }],
      },
      loadConfig({ CONTROLLER_BOT_TOKEN: "bot-token" }),
      fetchImpl,
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ photo: "ru-image", caption: "Русский текст" });
  });

  it("sets a heart reaction after a successful channel publication", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await publishToTelegram({ text_en: "Post" }, loadConfig({ CONTROLLER_BOT_TOKEN: "bot-token" }), fetchImpl);
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining("/sendMessage"),
      expect.stringContaining("/setMessageReaction"),
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({ message_id: 42, reaction: [{ type: "emoji", emoji: "❤" }] });
  });

  it("uploads a local Studio asset when it has no Telegram file id", async () => {
    const imagePath = tempImage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as unknown as typeof fetch;

    await publishToTelegram(
      { text_en: "Asset", media: [{ type: "photo", local_path: imagePath }] },
      loadConfig({ CONTROLLER_BOT_TOKEN: "bot-token" }),
      fetchImpl,
    );

    const form = calls[0]?.init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error("expected multipart Telegram request");
    expect(form.get("photo")).toBe("attach://file-photo");
    expect(form.get("caption")).toBe("Asset");
    expect(form.get("file-photo")).toBeInstanceOf(File);
  });

  it("never sends caption entities beyond the Telegram media-caption limit", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await publishToTelegram(
      {
        text: "А".repeat(1024) + "Б".repeat(30),
        entities: [{ type: "bold", offset: 1025, length: 10 }],
        media: [{ type: "photo", file_id: "image" }],
      },
      loadConfig({ CONTROLLER_BOT_TOKEN: "bot-token" }),
      fetchImpl,
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(String(body.caption)).toHaveLength(1024);
    expect(body.caption_entities).toEqual([]);
  });
});

describe("Threads publisher", () => {
  it("retries a transient media availability error without publishing a duplicate", async () => {
    let creates = 0;
    const fetchImpl = mock(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("fields=status")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      if (url.includes("fields=permalink"))
        return new Response(JSON.stringify({ permalink: "https://threads.net/@a/post/1" }), { status: 200 });
      if (url.includes("threads_publish")) return new Response(JSON.stringify({ id: "published-1" }), { status: 200 });
      creates += 1;
      return creates === 1
        ? new Response(JSON.stringify({ error: { message: "media is missing" } }), { status: 503 })
        : new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await publishToThreads(
      { text_en: "Post", media: [{ type: "IMAGE", vps_url: "https://example.com/image.jpg" }] },
      loadConfig({ THREADS_ACCESS_TOKEN: "token", THREADS_CONTAINER_TIMEOUT_SECONDS: "1", THREADS_RETRY_DELAY_MS: "1" }),
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: true, ids: ["published-1"] });
    expect(creates).toBe(2);
  });

  it("resumes a partial thread after the last published reply", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("fields=status")) return new Response(JSON.stringify({ status: "FINISHED" }), { status: 200 });
      if (url.includes("fields=permalink"))
        return new Response(JSON.stringify({ permalink: "https://www.threads.net/@a/post/root" }), { status: 200 });
      if (url.includes("threads_publish")) return new Response(JSON.stringify({ id: "reply-2" }), { status: 200 });
      return new Response(JSON.stringify({ id: "container-2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await publishToThreads(
      { text_en: `${"A".repeat(470)} ${"B".repeat(120)}`, _threadsPublishedIds: ["root-1"] },
      loadConfig({ THREADS_ACCESS_TOKEN: "token", THREADS_CONTAINER_TIMEOUT_SECONDS: "1" }),
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: true, ids: ["root-1", "reply-2"] });
    const creation = calls.find((call) => call.url.endsWith("/me/threads"));
    expect(String(creation?.init?.body)).toContain("reply_to_id=root-1");
    expect(calls.filter((call) => call.url.endsWith("/me/threads")).length).toBe(1);
  });
});

describe("X publisher", () => {
  it("uploads an image and creates a tweet with OAuth 1.0a", async () => {
    const imagePath = tempImage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("media/upload.json")) return new Response(JSON.stringify({ media_id_string: "media-1" }), { status: 200 });
      return new Response(JSON.stringify({ data: { id: "tweet-1" } }), { status: 201 });
    }) as unknown as typeof fetch;
    const config = xConfig();

    const result = await publishToX(
      { text_en: "Post https://example.com/source", media: [{ type: "IMAGE", local_path: imagePath }] },
      config,
      fetchImpl,
    );

    expect(result).toMatchObject({ ok: true, id: "tweet-1", url: "https://x.com/i/web/status/tweet-1" });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      if (!call.init) throw new Error("missing X request init");
      expect((call.init.headers as Record<string, string>).Authorization).toMatch(/^OAuth .*oauth_signature=/);
    }
    const postCall = calls[1];
    if (!postCall?.init) throw new Error("missing X post request");
    expect(JSON.parse(String(postCall.init.body))).toEqual({ text: "Post", media: { media_ids: ["media-1"] } });
  });

  it("produces a deterministic OAuth signature", () => {
    const header = oauthAuthorization("POST", "https://api.twitter.com/2/tweets", xConfig(), undefined, "fixed-nonce", 1_700_000_000);
    expect(header).toContain('oauth_nonce="fixed-nonce"');
    expect(header).toContain('oauth_timestamp="1700000000"');
    expect(header).toMatch(/oauth_signature="[^"]+"/);
  });
});

describe("Bluesky publisher", () => {
  it("uploads a prepared local image into the first post", async () => {
    const imagePath = tempImage();
    const fetchMock = mock(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("createSession")) return new Response(JSON.stringify({ did: "did:plc:1", accessJwt: "jwt" }), { status: 200 });
      if (url.includes("uploadBlob"))
        return new Response(JSON.stringify({ blob: { $type: "blob", ref: { $link: "blob-1" } } }), { status: 200 });
      if (url.includes("createRecord"))
        return new Response(JSON.stringify({ uri: "at://did/app.bsky.feed.post/root", cid: "cid" }), { status: 200 });
      return new Response(JSON.stringify({ feed: [{ post: { uri: "at://did/app.bsky.feed.post/root" } }] }), { status: 200 });
    });
    await publishToBluesky(
      { text_en: "Post", media: [{ type: "IMAGE", local_path: imagePath }] },
      loadConfig({ BLUESKY_HANDLE: "me.test", BLUESKY_APP_PASSWORD: "password" }),
      fetchMock as unknown as typeof fetch,
    );
    const recordCall = fetchMock.mock.calls.find(([url]) => String(url).includes("createRecord"));
    expect(String(recordCall?.[1]?.body)).toContain("app.bsky.embed.images");
  });

  it("marks a created root post retryable when it is not visible in the author feed", async () => {
    const calls: string[] = [];
    const fetchImpl = mock(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("createSession")) return new Response(JSON.stringify({ did: "did:plc:1", accessJwt: "jwt" }), { status: 200 });
      if (url.includes("createRecord"))
        return new Response(JSON.stringify({ uri: "at://did/app.bsky.feed.post/root", cid: "cid" }), { status: 200 });
      return new Response(JSON.stringify({ feed: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await publishToBluesky(
      { text_en: "Post" },
      loadConfig({ BLUESKY_HANDLE: "alexgetmancom.bsky.social", BLUESKY_APP_PASSWORD: "password" }),
      fetchImpl,
    );

    expect(result).toMatchObject({ ok: false, retryable: true, error: "bluesky_visibility_failed:not_in_author_feed" });
    expect(calls.some((url) => url.includes("getAuthorFeed"))).toBe(true);
  });

  it("reconciles a previously created post without creating a duplicate", async () => {
    const calls: string[] = [];
    const fetchImpl = mock(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ feed: [{ post: { uri: "at://did/app.bsky.feed.post/root" } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await publishToBluesky(
      { _reconcile_ids: ["at://did/app.bsky.feed.post/root"] },
      loadConfig({ BLUESKY_HANDLE: "alexgetmancom.bsky.social", BLUESKY_APP_PASSWORD: "password" }),
      fetchImpl,
    );

    expect(result).toMatchObject({ ok: true, id: "at://did/app.bsky.feed.post/root" });
    expect(calls.some((url) => url.includes("createSession") || url.includes("createRecord"))).toBe(false);
  });
});

function tempImage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-social-"));
  tempDirs.push(dir);
  const file = path.join(dir, "image.jpg");
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return file;
}

function xConfig() {
  return loadConfig({
    X_CONSUMER_KEY: "consumer-key",
    X_CONSUMER_SECRET: "consumer-secret",
    X_ACCESS_TOKEN: "access-token",
    X_ACCESS_TOKEN_SECRET: "access-secret",
  });
}
