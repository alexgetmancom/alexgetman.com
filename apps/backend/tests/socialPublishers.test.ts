import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { publishToLinkedIn } from "../src/social/linkedin.js";
import { payloadMedia, payloadText } from "../src/social/payload.js";
import { publishToThreads } from "../src/social/threads.js";
import { oauthAuthorization, publishToX } from "../src/social/x.js";

const tempDirs: string[] = [];

describe("publish payload validation", () => {
  it("drops malformed text and media values without throwing", () => {
    expect(payloadText({ text_en: 42 } as unknown as Record<string, unknown>)).toBe("");
    expect(payloadMedia({ media: [{ type: "video", local_path: 7 }, null, { type: "photo", file_id: "ok" }] })).toEqual([
      { type: "IMAGE", fileId: "ok" },
    ]);
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("LinkedIn publisher", () => {
  it("initializes an image upload and creates a post", async () => {
    const imagePath = tempImage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("images?action=initializeUpload")) {
        return new Response(JSON.stringify({ value: { uploadUrl: "https://upload.linkedin.test/image", image: "urn:li:image:1" } }), {
          status: 200,
        });
      }
      if (url === "https://upload.linkedin.test/image") return new Response("", { status: 201 });
      return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:55" } });
    }) as unknown as typeof fetch;
    const config = loadConfig({ LINKEDIN_ACCESS_TOKEN: "token", LINKEDIN_AUTHOR_URN: "urn:li:person:1" });

    const result = await publishToLinkedIn({ text_en: "🚀 Launch", media: [{ type: "IMAGE", local_path: imagePath }] }, config, fetchImpl);

    expect(result).toMatchObject({ ok: true, id: "urn:li:share:55" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.linkedin.com/rest/images?action=initializeUpload",
      "https://upload.linkedin.test/image",
      "https://api.linkedin.com/rest/posts",
    ]);
    const postCall = calls[2];
    if (!postCall?.init) throw new Error("missing LinkedIn post request");
    const postBody = JSON.parse(String(postCall.init.body)) as Record<string, unknown>;
    expect(postBody).toMatchObject({ author: "urn:li:person:1", commentary: "Launch", content: { media: { id: "urn:li:image:1" } } });
    expect((postCall.init.headers as Record<string, string>)["Linkedin-Version"]).toBe("202606");
  });
});

describe("Threads publisher", () => {
  it("resumes a partial thread after the last published reply", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
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
