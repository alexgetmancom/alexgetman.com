import { describe, expect, it, mock } from "bun:test";
import { publishToBluesky } from "../src/delivery/social/bluesky.js";
import { loadConfig } from "../src/foundation/config.js";

function config(handle: string) {
  return loadConfig({ BLUESKY_HANDLE: handle, BLUESKY_APP_PASSWORD: "secret" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Bluesky publisher session caching", () => {
  it("reuses the cached session across publish calls instead of logging in every time", async () => {
    let sessionCalls = 0;
    const fetchMock = mock(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("createSession")) {
        sessionCalls += 1;
        return jsonResponse({ did: "did:plc:abc", accessJwt: "jwt-1" });
      }
      if (href.includes("createRecord")) return jsonResponse({ uri: "at://did:plc:abc/app.bsky.feed.post/1", cid: "cid1" });
      if (href.includes("getAuthorFeed")) return jsonResponse({ feed: [{ post: { uri: "at://did:plc:abc/app.bsky.feed.post/1" } }] });
      throw new Error(`unexpected url ${href}`);
    });

    const cfg = config("reuse-session.bsky.social");
    await publishToBluesky({ text_en: "Hello" }, cfg, fetchMock as unknown as typeof fetch);
    await publishToBluesky({ text_en: "World" }, cfg, fetchMock as unknown as typeof fetch);

    expect(sessionCalls).toBe(1);
  });

  it("refreshes the session and retries once when the cached token is rejected with 401", async () => {
    let sessionCalls = 0;
    let createRecordCalls = 0;
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("createSession")) {
        sessionCalls += 1;
        return jsonResponse({ did: "did:plc:abc", accessJwt: `jwt-${sessionCalls}` });
      }
      if (href.includes("createRecord")) {
        createRecordCalls += 1;
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth === "Bearer jwt-1") return jsonResponse({ message: "expired token" }, 401);
        return jsonResponse({ uri: "at://did:plc:abc/app.bsky.feed.post/1", cid: "cid1" });
      }
      if (href.includes("getAuthorFeed")) return jsonResponse({ feed: [{ post: { uri: "at://did:plc:abc/app.bsky.feed.post/1" } }] });
      throw new Error(`unexpected url ${href}`);
    });

    const result = await publishToBluesky({ text_en: "Hello" }, config("retry-on-401.bsky.social"), fetchMock as unknown as typeof fetch);

    expect(result.ok).toBe(true);
    expect(sessionCalls).toBe(2);
    expect(createRecordCalls).toBe(2);
  });
});
