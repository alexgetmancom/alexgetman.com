import { describe, expect, it, mock } from "bun:test";
import { devtoArticleFromPayload, publishToDevto } from "../src/delivery/social/devto.js";
import { loadConfig } from "../src/foundation/config.js";

describe("Dev.to publisher", () => {
  it("builds article input from legacy job payload", () => {
    const article = devtoArticleFromPayload(
      {
        post_id: 42,
        slug_en: "hello-world",
        text_en: "Hello world\nBody",
        tags: ["AI News", "self-hosted", "typescript", "extra", "ignored"],
      },
      loadConfig({ PUBLIC_BASE_URL: "https://alexgetman.com" }),
    );
    expect(article).toMatchObject({
      title: "Hello world",
      bodyMarkdown: "Hello world\nBody",
      canonicalUrl: "https://alexgetman.com/42/hello-world/",
      published: true,
    });
  });

  it("embeds the first public image in Markdown exactly once", () => {
    const article = devtoArticleFromPayload(
      { title: "Title", text_en: "Body", media: [{ type: "IMAGE", vps_url: "https://alexgetman.com/media/post.jpg" }] },
      loadConfig({}),
    );
    expect(article.bodyMarkdown).toBe("![Title](https://alexgetman.com/media/post.jpg)\n\nBody");
    expect(article.mainImage).toBe("https://alexgetman.com/media/post.jpg");
  });

  it("sends Dev.to API request with normalized tags and auth", async () => {
    const fetchMock = mock(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: 123, url: "https://dev.to/a/post" }), { status: 201 }),
    );
    const result = await publishToDevto(
      {
        title: "Title",
        bodyMarkdown: "Body",
        canonicalUrl: "https://alexgetman.com/1/title/",
        tags: ["AI News", "Type-Script", "LongTagLongTagLongTag"],
      },
      loadConfig({ DEVTO_API_KEY: "secret" }),
      fetchMock as unknown as typeof fetch,
    );

    expect(result).toMatchObject({ ok: true, id: 123, url: "https://dev.to/a/post" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "api-key": "secret" });
    expect(JSON.parse(String(init.body))).toEqual({
      article: {
        title: "Title",
        body_markdown: "Body",
        canonical_url: "https://alexgetman.com/1/title/",
        published: true,
        tags: ["ainews", "typescript", "longtaglongtaglongta"],
      },
    });
  });
});
