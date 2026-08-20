import { describe, expect, it } from "bun:test";
import { isAmbiguousPublicationError } from "../src/delivery/ambiguous-publication.js";
import { publishXArticle } from "../src/delivery/social/x.js";
import { loadTestConfig } from "./helpers/studio-config.js";

// The OAuth token lives in the database, so env never carries it into config.
const config = Object.assign(loadTestConfig({}), { X_ACCESS_TOKEN: "token" });
const body = { title: "Chapter one", text: "Body text.", entities: [] };

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** A fetch stand-in that still satisfies the real signature. */
function stubFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return Object.assign(async (input: URL | RequestInfo) => handler(input instanceof Request ? input.url : String(input)), {
    preconnect: fetch.preconnect,
  }) as typeof fetch;
}

describe("X Article delivery", () => {
  it("drafts then publishes, and reports the published article", async () => {
    const calls: string[] = [];
    const result = await publishXArticle(
      body,
      config,
      stubFetch((url) => {
        calls.push(url);
        return jsonResponse({ data: { id: "a1" } });
      }),
    );
    expect(calls).toEqual(["https://api.x.com/2/articles/draft", "https://api.x.com/2/articles/a1/publish"]);
    expect(result.ok).toBe(true);
    expect(result.id).toBe("a1");
  });

  it("hands the draft id back so a retry publishes it instead of writing a second article", async () => {
    const result = await publishXArticle(
      body,
      config,
      stubFetch((url) => (url.endsWith("/publish") ? jsonResponse({ detail: "rate limited" }, 429) : jsonResponse({ data: { id: "a2" } }))),
    );
    expect(result.partial).toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.resumeKey).toBe("_xArticleDraftId");
    expect(result.ids).toEqual(["a2"]);
  });

  it("publishes the resumed draft without drafting again", async () => {
    const calls: string[] = [];
    const result = await publishXArticle(
      { ...body, _xArticleDraftId: ["a3"] },
      config,
      stubFetch((url) => {
        calls.push(url);
        return jsonResponse({ data: { id: "a3" } });
      }),
    );
    expect(calls).toEqual(["https://api.x.com/2/articles/a3/publish"]);
    expect(result.ok).toBe(true);
  });

  it("treats a lost publish call as ambiguous rather than retrying it", async () => {
    const failed = await publishXArticle(
      { ...body, _xArticleDraftId: ["a4"] },
      config,
      stubFetch(() => {
        throw new TypeError("fetch failed");
      }),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(isAmbiguousPublicationError(failed)).toBe(true);
  });

  it("refuses an article with no title instead of drafting an untitled one", async () => {
    let called = false;
    const result = await publishXArticle(
      { text: "Body." },
      config,
      stubFetch(() => {
        called = true;
        return jsonResponse({ data: { id: "never" } });
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe("x_article_title_missing");
    expect(called).toBe(false);
  });
});
