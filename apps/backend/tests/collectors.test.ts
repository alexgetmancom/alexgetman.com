import { describe, expect, it } from "bun:test";
import { isTerminalMetricError } from "../src/analytics/collection/collectors/errors.js";
import { collectInstagramStory } from "../src/analytics/collection/collectors/meta.js";
import { collectTelegram, collectTelegramStory } from "../src/analytics/collection/collectors/telegram.js";
import { collectThreads } from "../src/analytics/collection/collectors/threads.js";
import { collectX } from "../src/analytics/collection/collectors/x.js";
import type { MetricTask } from "../src/analytics/collection/metric-schedule.js";
import { loadConfig } from "../src/foundation/config.js";

const config = loadConfig({
  ADMIN_IDS: "42",
  CONTROLLER_BOT_TOKEN: "token",
  X_CONSUMER_KEY: "ck",
  X_CONSUMER_SECRET: "cs",
  X_ACCESS_TOKEN: "at",
  X_ACCESS_TOKEN_SECRET: "ats",
  THREADS_ACCESS_TOKEN: "ru-token",
  THREADS_EN_ACCESS_TOKEN: "en-token",
  INSTAGRAM_ACCESS_TOKEN: "shared-token",
});

function task(overrides: Partial<MetricTask> = {}): MetricTask {
  return {
    postKey: "post:106",
    target: "x",
    checkCount: 0,
    messageId: 106,
    dateUtc: "2026-07-27T10:00:00.000Z",
    externalId: "1234",
    externalIds: ["1234"],
    url: null,
    lockId: "test-worker",
    ...overrides,
  };
}

/** Records every request so a test can assert what was actually asked for —
 * host, query and headers are part of these collectors' contracts. */
function recordingFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Returns the Error a call rejected with, and fails the test if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
  );
  if (!error) throw new Error("expected the call to reject");
  return error;
}

describe("collectTelegram", () => {
  it("rejects malformed Telegram story tasks before opening MTProto", async () => {
    const storyTask = task({ target: "telegram_stories", externalId: "not-a-number" });
    const storyConfig = loadConfig({
      TELEGRAM_CHANNEL_STORIES_API_ID: "123",
      TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
      TELEGRAM_CHANNEL_STORIES_SESSION: "session",
    });
    await expect(collectTelegramStory(storyTask, storyConfig)).rejects.toThrow("invalid_telegram_story_id:not-a-number");
    await expect(collectTelegramStory({ ...storyTask, externalId: null }, config)).rejects.toThrow(
      "missing_telegram_story_credentials_or_id",
    );
  });

  it("accepts Telegram links and converts compact view and reaction counts", async () => {
    const telegramConfig = loadConfig({ CHANNEL_USERNAME: "@alexchannel" });
    const fetchMock = (async () =>
      new Response(
        '<section data-post="alexchannel/42"><span class="tgme_widget_message_views">1.2K</span><i class="tgme_reaction">x</i>3</section>',
      )) as unknown as typeof fetch;

    await expect(
      collectTelegram({ ...task({ target: "telegram", externalId: null }), url: "https://t.me/alexchannel/42" }, telegramConfig, fetchMock),
    ).resolves.toMatchObject({ metrics: { views: 1200, likes: 3 } });
  });
});

describe("collectX", () => {
  it("maps public_metrics onto the dashboard metric names", async () => {
    const { fetch: impl } = recordingFetch(() =>
      json({ data: { public_metrics: { impression_count: 900, like_count: 12, reply_count: 3, retweet_count: 4, quote_count: 1 } } }),
    );

    expect(await collectX(task(), config, impl)).toMatchObject({
      metrics: { views: 900, likes: 12, replies: 3, reposts: 4, quotes: 1 },
      source: "x_api_v2",
    });
  });

  it("asks for the metrics field and signs the request", async () => {
    const { fetch: impl, calls } = recordingFetch(() => json({ data: { public_metrics: {} } }));
    await collectX(task({ externalId: "id with space" }), config, impl);

    expect(calls[0]?.url).toBe("https://api.twitter.com/2/tweets/id%20with%20space?tweet.fields=public_metrics");
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toStartWith("OAuth ");
  });

  it("reports zeroes when the payload carries no metrics at all", async () => {
    const { fetch: impl } = recordingFetch(() => json({}));

    expect((await collectX(task(), config, impl)).metrics).toEqual({ views: 0, likes: 0, replies: 0, reposts: 0, quotes: 0 });
  });

  it("refuses to call out without a tweet id", async () => {
    const { fetch: impl, calls } = recordingFetch(() => json({}));
    await expect(collectX(task({ externalId: null }), config, impl)).rejects.toThrow("missing_x_tweet_id");
    expect(calls).toEqual([]);
  });

  it("surfaces the status in the error and redacts the token from the body", async () => {
    const { fetch: impl } = recordingFetch(() => new Response('{"detail":"token=super-secret-value"}', { status: 429 }));

    const error = await rejection(collectX(task(), config, impl));
    expect(error.message).toContain("X metrics 429");
    expect(error.message).not.toContain("super-secret-value");
  });
});

describe("collectThreads", () => {
  it("sums insight values across every external id and keeps a per-id breakdown", async () => {
    const { fetch: impl } = recordingFetch((url) =>
      json({
        data: [
          { name: "views", values: [{ value: url.includes("/first/") ? 100 : 40 }] },
          { name: "likes", values: [{ value: 2 }] },
        ],
      }),
    );

    const result = await collectThreads(
      task({ target: "threads_ru", externalIds: ["first", "second"], url: "https://x.test/p" }),
      config,
      impl,
    );
    expect(result.metrics).toEqual({ views: 140, likes: 4 });
    expect(result.source).toBe("threads_insights_api");
    expect(result.raw).toMatchObject({ parts: [{ id: "first" }, { id: "second" }] });
  });

  it("uses the English token for threads_en and the Russian one otherwise", async () => {
    const { fetch: impl, calls } = recordingFetch(() => json({ data: [] }));
    await collectThreads(task({ target: "threads_en", url: "https://x.test/p" }), config, impl);
    await collectThreads(task({ target: "threads_ru", url: "https://x.test/p" }), config, impl);

    expect(calls[0]?.url).toContain("access_token=en-token");
    expect(calls[1]?.url).toContain("access_token=ru-token");
  });

  it("falls back to the Russian token when no English one is configured", async () => {
    const ruOnly = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t", THREADS_ACCESS_TOKEN: "ru-token" });
    const { fetch: impl, calls } = recordingFetch(() => json({ data: [] }));
    await collectThreads(task({ target: "threads_en", url: "https://x.test/p" }), ruOnly, impl);

    expect(calls[0]?.url).toContain("access_token=ru-token");
  });

  it("fetches the permalink only when the task has no URL, and rewrites threads.net", async () => {
    const { fetch: impl, calls } = recordingFetch((url) =>
      url.includes("fields=permalink") ? json({ permalink: "https://www.threads.net/@a/post/1" }) : json({ data: [] }),
    );

    const result = await collectThreads(task({ target: "threads_ru", url: null }), config, impl);
    expect(result.url).toBe("https://www.threads.com/@a/post/1");
    expect(calls.some((call) => call.url.includes("fields=permalink"))).toBe(true);

    const withUrl = recordingFetch(() => json({ data: [] }));
    const kept = await collectThreads(task({ target: "threads_ru", url: "https://existing.test/p" }), config, withUrl.fetch);
    expect(kept.url).toBe("https://existing.test/p");
    expect(withUrl.calls.some((call) => call.url.includes("fields=permalink"))).toBe(false);
  });

  it("refuses to call out with no token or no ids", async () => {
    const noToken = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t" });
    const { fetch: impl, calls } = recordingFetch(() => json({ data: [] }));

    await expect(collectThreads(task({ target: "threads_ru" }), noToken, impl)).rejects.toThrow("missing_threads_token_or_id");
    await expect(collectThreads(task({ target: "threads_ru", externalIds: [] }), config, impl)).rejects.toThrow(
      "missing_threads_token_or_id",
    );
    expect(calls).toEqual([]);
  });

  it("turns a deleted post into a terminal error so the checkpoint stops retrying", async () => {
    const { fetch: impl } = recordingFetch(() => json({ error: { message: "Object does not exist" } }, 404));

    const error = await collectThreads(task({ target: "threads_ru" }), config, impl).catch((thrown: unknown) => thrown);
    expect(isTerminalMetricError(error)).toBe(true);
  });

  it("leaves a server fault retryable", async () => {
    const { fetch: impl } = recordingFetch(() => json({ error: "upstream" }, 503));

    const error = await collectThreads(task({ target: "threads_ru" }), config, impl).catch((thrown: unknown) => thrown);
    expect(isTerminalMetricError(error)).toBe(false);
  });
});

describe("collectInstagramStory", () => {
  const storyTask = (overrides: Partial<MetricTask> = {}) => task({ target: "instagram_stories", externalId: "story-1", ...overrides });

  it("maps story insights and folds in the like count", async () => {
    const { fetch: impl } = recordingFetch((url) =>
      url.includes("/insights")
        ? json({
            data: [
              { name: "views", values: [{ value: 700 }] },
              { name: "reach", values: [{ value: 650 }] },
              { name: "replies", values: [{ value: 5 }] },
              { name: "shares", values: [{ value: 2 }] },
              { name: "total_interactions", values: [{ value: 20 }] },
              { name: "navigation", values: [{ value: 90 }] },
            ],
          })
        : json({ like_count: 11 }),
    );

    expect(await collectInstagramStory(storyTask(), config, impl)).toMatchObject({
      metrics: { views: 700, reach: 650, likes: 11, replies: 5, reposts: 2, total_interactions: 20, navigation: 90 },
      source: "instagram_graph_api",
    });
  });

  it("falls back to reach when the API reports no views", async () => {
    const { fetch: impl } = recordingFetch((url) =>
      url.includes("/insights") ? json({ data: [{ name: "reach", values: [{ value: 400 }] }] }) : json({ like_count: 0 }),
    );

    expect((await collectInstagramStory(storyTask(), config, impl)).metrics).toMatchObject({ views: 400, reach: 400 });
  });

  it("keeps the insights when the expired media fields fail", async () => {
    const { fetch: impl } = recordingFetch((url) =>
      url.includes("/insights") ? json({ data: [{ name: "views", values: [{ value: 12 }] }] }) : json({ error: "expired" }, 400),
    );

    expect((await collectInstagramStory(storyTask(), config, impl)).metrics).toMatchObject({ views: 12, likes: 0 });
  });

  it("routes an IG-prefixed token to graph.instagram.com and anything else to graph.facebook.com", async () => {
    const igConfig = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t", INSTAGRAM_EN_ACCESS_TOKEN: "IGtoken" });
    const ig = recordingFetch(() => json({ data: [] }));
    await collectInstagramStory(storyTask(), igConfig, ig.fetch);
    expect(ig.calls[0]?.url).toStartWith("https://graph.instagram.com/");

    const fb = recordingFetch(() => json({ data: [] }));
    await collectInstagramStory(storyTask(), config, fb.fetch);
    expect(fb.calls[0]?.url).toStartWith("https://graph.facebook.com/");
  });

  it("prefers the locale token over the shared one", async () => {
    const perLocale = loadConfig({
      ADMIN_IDS: "42",
      CONTROLLER_BOT_TOKEN: "t",
      INSTAGRAM_ACCESS_TOKEN: "shared",
      INSTAGRAM_RU_ACCESS_TOKEN: "ru-only",
    });
    const { fetch: impl, calls } = recordingFetch(() => json({ data: [] }));
    await collectInstagramStory(storyTask({ target: "instagram_stories_ru" }), perLocale, impl);

    expect(calls[0]?.url).toContain("access_token=ru-only");
  });

  it("refuses to call out with no token or no story id", async () => {
    const noToken = loadConfig({ ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t" });
    const { fetch: impl, calls } = recordingFetch(() => json({ data: [] }));

    await expect(collectInstagramStory(storyTask(), noToken, impl)).rejects.toThrow("missing_instagram_story_token_or_id");
    await expect(collectInstagramStory(storyTask({ externalId: null }), config, impl)).rejects.toThrow(
      "missing_instagram_story_token_or_id",
    );
    expect(calls).toEqual([]);
  });

  it("turns an expired story into a terminal error", async () => {
    const { fetch: impl } = recordingFetch(() => json({ error: { message: "Unsupported get request" } }, 400));

    const error = await collectInstagramStory(storyTask(), config, impl).catch((thrown: unknown) => thrown);
    expect(isTerminalMetricError(error)).toBe(true);
  });
});
