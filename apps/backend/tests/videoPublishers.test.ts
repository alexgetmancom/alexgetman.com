import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InstagramContainerInvalidError,
  InstagramContainerProcessingError,
  instagramContainerReady,
  keepYouTubeUploadPrivate,
  prepareInstagramReel,
  prepareYouTubeVideo,
  publishInstagramReel,
  verifyInstagramReel,
} from "../src/delivery/video-publishers.js";
import { loadConfig } from "../src/foundation/config.js";

/**
 * These publishers reach for the global fetch rather than taking one, so the
 * tests install their own (the suite's preload otherwise fails any outbound
 * call — see tests/helpers/no-network.ts).
 *
 * What matters here is not that a request is made but which one: a YouTube
 * status update that omits a preserved field silently resets it on the real
 * channel, and an Instagram container error that is not classified as expired
 * makes the worker retry a creation_id that can never succeed.
 */

const config = loadConfig({
  YOUTUBE_CLIENT_ID: "client",
  YOUTUBE_CLIENT_SECRET: "secret",
  YOUTUBE_REFRESH_TOKEN: "refresh",
  YOUTUBE_EN_CLIENT_ID: "client-en",
  YOUTUBE_EN_CLIENT_SECRET: "secret-en",
  YOUTUBE_EN_REFRESH_TOKEN: "refresh-en",
  INSTAGRAM_ACCESS_TOKEN: "EAAB-facebook-token",
  INSTAGRAM_USER_ID: "ig-user",
});

type Recorded = { url: string; method: string; body?: unknown; headers: Headers };

const realFetch = globalThis.fetch;
let recorded: Recorded[] = [];

function install(handler: (call: Recorded) => Response | Promise<Response>): void {
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Recorded = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body,
      headers: new Headers(init?.headers as HeadersInit),
    };
    recorded.push(call);
    // Every path first exchanges the refresh token; answer that centrally so
    // each test only scripts what it is actually about.
    if (call.url.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "ya29-token" }), { status: 200 });
    return handler(call);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  recorded = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("prepareYouTubeVideo", () => {
  it("uses English channel credentials and language metadata for an EN video", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-upload-en-"));
    try {
      const file = path.join(dir, "clip.mp4");
      fs.writeFileSync(file, Buffer.alloc(16));
      install((call) =>
        call.url.includes("uploadType=resumable")
          ? new Response("", { status: 200, headers: { location: "https://upload.googleapis.com/session/en" } })
          : json({ id: "vid-en" }),
      );

      await prepareYouTubeVideo(config, file, { title: "Title", description: "Body", tags: [] }, "2026-08-01T10:00:00Z", "en");

      const oauth = recorded.find((call) => call.url.includes("oauth2.googleapis.com/token"));
      expect(String(oauth?.body)).toContain("refresh_token=refresh-en");
      const session = recorded.find((call) => call.url.includes("uploadType=resumable"));
      expect(JSON.parse(String(session?.body)).snippet).toMatchObject({ defaultLanguage: "en", defaultAudioLanguage: "en" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("opens a resumable session, uploads the file and returns the watch URL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-upload-"));
    try {
      const file = path.join(dir, "clip.mp4");
      fs.writeFileSync(file, Buffer.alloc(2048, 3));
      install((call) => {
        if (call.url.includes("uploadType=resumable"))
          return new Response("", { status: 200, headers: { location: "https://upload.googleapis.com/session/1" } });
        return json({ id: "vid-1" });
      });

      const result = await prepareYouTubeVideo(config, file, { title: "Title", description: "Body", tags: ["a"] }, "2026-08-01T10:00:00Z");

      const session = recorded.find((call) => call.url.includes("uploadType=resumable"));
      expect(session?.headers.get("X-Upload-Content-Length")).toBe("2048");
      const body = JSON.parse(String(session?.body));
      // Uploads start private and are released by publishAt; anything else
      // makes the video public the moment it finishes processing.
      expect(body.status).toMatchObject({ privacyStatus: "private", publishAt: "2026-08-01T10:00:00Z" });
      expect(body.snippet).toMatchObject({ title: "Title", tags: ["a"] });

      const upload = recorded.find((call) => call.url === "https://upload.googleapis.com/session/1");
      expect(upload?.method).toBe("PUT");
      expect(result).toEqual({ id: "vid-1", url: "https://www.youtube.com/watch?v=vid-1" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queries the resumable session after a lost upload response instead of creating another video", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-upload-reconcile-"));
    try {
      const file = path.join(dir, "clip.mp4");
      fs.writeFileSync(file, Buffer.alloc(32, 4));
      let sessionCalls = 0;
      install((call) => {
        if (call.url.includes("uploadType=resumable"))
          return new Response("", { status: 200, headers: { location: "https://upload.googleapis.com/session/reconcile" } });
        sessionCalls += 1;
        if (sessionCalls === 1) throw new TypeError("connection closed");
        expect(call.headers.get("content-range")).toBe("bytes */32");
        return json({ id: "vid-reconciled" });
      });

      await expect(
        prepareYouTubeVideo(config, file, { title: "Title", description: "Body", tags: [] }, "2026-08-01T10:00:00Z"),
      ).resolves.toEqual({
        id: "vid-reconciled",
        url: "https://www.youtube.com/watch?v=vid-reconciled",
      });
      expect(recorded.filter((call) => call.url.includes("uploadType=resumable"))).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("queries again when every byte committed instead of sending an empty invalid range", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-upload-complete-"));
    try {
      const file = path.join(dir, "clip.mp4");
      fs.writeFileSync(file, Buffer.alloc(32, 5));
      let sessionCalls = 0;
      install((call) => {
        if (call.url.includes("uploadType=resumable"))
          return new Response("", { status: 200, headers: { location: "https://upload.googleapis.com/session/complete" } });
        sessionCalls += 1;
        if (sessionCalls === 1) throw new TypeError("response lost");
        if (sessionCalls === 2) return new Response("", { status: 308, headers: { range: "bytes=0-31" } });
        expect(call.headers.get("content-range")).toBe("bytes */32");
        return json({ id: "vid-complete" });
      });

      await expect(
        prepareYouTubeVideo(config, file, { title: "Title", description: "Body", tags: [] }, "2026-08-01T10:00:00Z"),
      ).resolves.toMatchObject({ id: "vid-complete" });
      expect(recorded.some((call) => call.headers.get("content-range") === "bytes 32-31/32")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails clearly when YouTube accepts the session but returns no upload location", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-upload-"));
    try {
      const file = path.join(dir, "clip.mp4");
      fs.writeFileSync(file, Buffer.alloc(16));
      install(() => new Response("", { status: 200 }));
      await expect(prepareYouTubeVideo(config, file, { title: "t", description: "d", tags: [] }, "2026-08-01T10:00:00Z")).rejects.toThrow(
        "YouTube did not return an upload location.",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the session failure body instead of a bare status", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "youtube-upload-"));
    try {
      const file = path.join(dir, "clip.mp4");
      fs.writeFileSync(file, Buffer.alloc(16));
      install(() => new Response("quotaExceeded", { status: 403 }));
      await expect(prepareYouTubeVideo(config, file, { title: "t", description: "d", tags: [] }, "2026-08-01T10:00:00Z")).rejects.toThrow(
        /403 quotaExceeded/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("keepYouTubeUploadPrivate", () => {
  it("resends every mutable status field so cancelling a schedule does not reset them", async () => {
    install((call) => {
      if (call.method === "GET")
        return json({
          items: [
            {
              status: {
                license: "creativeCommon",
                embeddable: true,
                publicStatsViewable: false,
                selfDeclaredMadeForKids: false,
                containsSyntheticMedia: true,
              },
            },
          ],
        });
      return json({});
    });

    await keepYouTubeUploadPrivate(config, "vid-1");

    const update = recorded.find((call) => call.method === "PUT");
    const body = JSON.parse(String(update?.body));
    expect(body.status).toEqual({
      privacyStatus: "private",
      license: "creativeCommon",
      embeddable: true,
      publicStatsViewable: false,
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    });
    // Keeping publishAt would re-arm the release this call exists to cancel.
    expect(body.status.publishAt).toBeUndefined();
  });

  it("omits fields the channel never set rather than inventing defaults", async () => {
    install((call) => (call.method === "GET" ? json({ items: [{ status: { embeddable: true } }] }) : json({})));
    await keepYouTubeUploadPrivate(config, "vid-1");
    const body = JSON.parse(String(recorded.find((call) => call.method === "PUT")?.body));
    expect(body.status).toEqual({ privacyStatus: "private", embeddable: true });
  });

  it("refuses to guess when the upload cannot be found", async () => {
    install(() => json({ items: [] }));
    await expect(keepYouTubeUploadPrivate(config, "missing")).rejects.toThrow(
      "YouTube upload was not found while cancelling its schedule.",
    );
    expect(recorded.some((call) => call.method === "PUT")).toBe(false);
  });
});

describe("Instagram Reels", () => {
  it("creates a REELS container against the Graph host implied by the token", async () => {
    install(() => json({ id: "container-1" }));
    const result = await prepareInstagramReel(config, "https://cdn/clip.mp4", { caption: "  caption  " });

    const create = recorded.at(-1);
    expect(create?.url).toStartWith("https://graph.facebook.com/");
    const body = new URLSearchParams(String(create?.body));
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("video_url")).toBe("https://cdn/clip.mp4");
    expect(body.get("caption")).toBe("caption");
    expect(result).toEqual({ id: "container-1" });
  });

  it("switches to graph.instagram.com for an Instagram-issued token", async () => {
    install(() => json({ id: "container-1" }));
    await prepareInstagramReel({ ...config, INSTAGRAM_ACCESS_TOKEN: "IGAAB-token" }, "https://cdn/clip.mp4", { caption: "c" });
    expect(recorded.at(-1)?.url).toStartWith("https://graph.instagram.com/");
  });

  it("treats a FINISHED container as ready", async () => {
    install(() => json({ status_code: "FINISHED" }));
    await expect(instagramContainerReady(config, "container-1")).resolves.toBeUndefined();
  });

  it("keeps polling while the container is still processing", async () => {
    install(() => json({ status_code: "IN_PROGRESS" }));
    await expect(instagramContainerReady(config, "container-1")).rejects.toBeInstanceOf(InstagramContainerProcessingError);
  });

  it("marks an ERROR or EXPIRED container as unusable so the worker rebuilds it", async () => {
    for (const statusCode of ["ERROR", "EXPIRED"]) {
      install(() => json({ status_code: statusCode, status: "the reason" }));
      const failure = await instagramContainerReady(config, "container-1").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InstagramContainerInvalidError);
      expect(String(failure)).toContain("the reason");
    }
  });

  it("returns the canonical reel URL on publish", async () => {
    install(() => json({ id: "reel-9" }));
    await expect(publishInstagramReel(config, "container-1")).resolves.toEqual({
      id: "reel-9",
      url: "https://www.instagram.com/reel/reel-9/",
    });
  });

  it("verifies a published Reel by media id and permalink", async () => {
    install(() => json({ id: "reel-verified", permalink: "https://www.instagram.com/reel/reel-verified/" }));
    await expect(verifyInstagramReel(config, "reel-verified")).resolves.toEqual({
      id: "reel-verified",
      url: "https://www.instagram.com/reel/reel-verified/",
    });
  });

  it("classifies a 400 about a dead creation_id as an invalid container", async () => {
    install(() => new Response("(#2207027) Media ID is not available", { status: 400 }));
    await expect(publishInstagramReel(config, "container-1")).rejects.toBeInstanceOf(InstagramContainerInvalidError);
  });

  it("leaves a transient failure retryable rather than rebuilding the container", async () => {
    install(() => new Response("(#2207027) Media ID is not available", { status: 500 }));
    const failure = await publishInstagramReel(config, "container-1").catch((error: unknown) => error);
    expect(failure).not.toBeInstanceOf(InstagramContainerInvalidError);
  });
});
