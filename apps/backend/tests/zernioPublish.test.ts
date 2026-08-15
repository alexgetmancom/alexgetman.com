import { describe, expect, it } from "bun:test";
import { publishZernioInstagramReel } from "../src/delivery/zernio.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t", ZERNIO_API_KEY: "zernio-placeholder-not-a-secret" });

const input = {
  accountId: "acct-1",
  publicUrl: "https://media.test/reel.mp4",
  metadata: { caption: "  A reel caption  " },
  requestId: "job-77",
};

function recordingFetch(handler: (url: string, init: RequestInit | undefined) => Response): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = async (target: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: target instanceof Request ? target.url : String(target), init });
    return handler(calls.at(-1)?.url ?? "", init);
  };
  return { fetch: impl as unknown as typeof fetch, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Returns the Error a call rejected with, and fails the test if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => (thrown instanceof Error ? thrown : new Error(String(thrown))),
  );
  if (!error) throw new Error("expected the call to reject");
  return error;
}

describe("publishZernioInstagramReel", () => {
  it("posts the reel and returns the provider id with the Instagram permalink", async () => {
    const { fetch: impl, calls } = recordingFetch(() =>
      json({
        _id: "zernio-1",
        platforms: [{ platform: "instagram", platformPostId: "ig-9", platformPostUrl: "https://instagram.com/p/ig-9" }],
      }),
    );

    expect(await publishZernioInstagramReel(config, input, impl)).toEqual({
      providerPostId: "zernio-1",
      externalId: "ig-9",
      url: "https://instagram.com/p/ig-9",
    });
    expect(calls[0]?.url).toBe("https://zernio.com/api/v1/posts");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("fences a retry with the request id and authorizes with the API key", async () => {
    const { fetch: impl, calls } = recordingFetch(() => json({ _id: "zernio-1" }));
    await publishZernioInstagramReel(config, input, impl);

    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-request-id"]).toBe("job-77");
    expect(headers.Authorization).toBe("Bearer zernio-placeholder-not-a-secret");
  });

  it("replays one lost response with the same request id and accepts `existingPost`", async () => {
    let attempt = 0;
    const { fetch: impl, calls } = recordingFetch(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("fetch failed: connection reset");
      return json({ existingPost: { _id: "zernio-after-timeout" } });
    });

    expect(await publishZernioInstagramReel(config, input, impl)).toMatchObject({ providerPostId: "zernio-after-timeout" });
    expect(calls.map((call) => ((call.init?.headers ?? {}) as Record<string, string>)["x-request-id"])).toEqual(["job-77", "job-77"]);
  });

  it("requires verification when both idempotent attempts lose their response", async () => {
    const { fetch: impl } = recordingFetch(() => {
      throw new Error("fetch failed: connection reset");
    });

    await expect(publishZernioInstagramReel(config, input, impl)).rejects.toThrow("verification_required: zernio may have published");
  });

  it("trims the caption and requests a feed-shared reel for the given account", async () => {
    const { fetch: impl, calls } = recordingFetch(() => json({ _id: "zernio-1" }));
    await publishZernioInstagramReel(config, input, impl);

    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      content: "A reel caption",
      mediaItems: [{ type: "video", url: "https://media.test/reel.mp4" }],
      platforms: [{ platform: "instagram", accountId: "acct-1", platformSpecificData: { contentType: "reels", shareToFeed: true } }],
      publishNow: true,
    });
  });

  it("accepts a response nested under `post` and an `id` instead of `_id`", async () => {
    const nested = recordingFetch(() => json({ post: { id: "zernio-2", platforms: [{ platform: "instagram", platformPostId: "ig-2" }] } }));
    expect(await publishZernioInstagramReel(config, input, nested.fetch)).toMatchObject({
      providerPostId: "zernio-2",
      externalId: "ig-2",
    });

    const flat = recordingFetch(() => json({ id: "zernio-3" }));
    expect(await publishZernioInstagramReel(config, input, flat.fetch)).toMatchObject({ providerPostId: "zernio-3" });
  });

  it("accepts Zernio's same-request idempotency response under `existingPost`", async () => {
    const { fetch: impl } = recordingFetch(() =>
      json({ existingPost: { _id: "zernio-existing", platforms: [{ platform: "instagram", platformPostId: "ig-existing" }] } }),
    );

    expect(await publishZernioInstagramReel(config, input, impl)).toMatchObject({
      providerPostId: "zernio-existing",
      externalId: "ig-existing",
    });
  });

  it("reads the permalink from platformAnalytics when platforms has not filled in yet", async () => {
    const { fetch: impl } = recordingFetch(() =>
      json({
        _id: "zernio-4",
        platforms: [],
        platformAnalytics: [{ platform: "instagram", platformPostId: "ig-4", platformPostUrl: "https://instagram.com/p/ig-4" }],
      }),
    );

    expect(await publishZernioInstagramReel(config, input, impl)).toMatchObject({
      externalId: "ig-4",
      url: "https://instagram.com/p/ig-4",
    });
  });

  it("ignores another platform's entry rather than reporting its id as the Instagram one", async () => {
    const { fetch: impl } = recordingFetch(() =>
      json({ _id: "zernio-5", platforms: [{ platform: "tiktok", platformPostId: "tt-5", platformPostUrl: "https://tiktok.test/5" }] }),
    );

    expect(await publishZernioInstagramReel(config, input, impl)).toEqual({
      providerPostId: "zernio-5",
      externalId: null,
      url: null,
    });
  });

  it("reports a published post with no platform ids as pending rather than failing", async () => {
    const { fetch: impl } = recordingFetch(() => json({ _id: "zernio-6" }));

    expect(await publishZernioInstagramReel(config, input, impl)).toEqual({ providerPostId: "zernio-6", externalId: null, url: null });
  });

  it("reconciles an exact-content conflict for the requested Instagram account", async () => {
    const { fetch: impl, calls } = recordingFetch((url) =>
      url.endsWith("/zernio-existing")
        ? json({
            post: {
              _id: "zernio-existing",
              platforms: [{ platform: "instagram", platformPostId: "ig-existing", platformPostUrl: "https://instagram.test/ig-existing" }],
            },
          })
        : json(
            {
              error: "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
              details: { accountId: "acct-1", platform: "instagram", existingPostId: "zernio-existing" },
            },
            409,
          ),
    );

    expect(await publishZernioInstagramReel(config, input, impl)).toEqual({
      providerPostId: "zernio-existing",
      externalId: "ig-existing",
      url: "https://instagram.test/ig-existing",
    });
    expect(calls.map((call) => call.url)).toEqual(["https://zernio.com/api/v1/posts", "https://zernio.com/api/v1/posts/zernio-existing"]);
  });

  it("does not reconcile a conflict for another account, platform, or reason", async () => {
    for (const body of [
      {
        error: "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
        details: { accountId: "another-account", platform: "instagram", existingPostId: "zernio-existing" },
      },
      {
        error: "This exact content is already scheduled, publishing, or was posted to this account within the last 24 hours.",
        details: { accountId: "acct-1", platform: "tiktok", existingPostId: "zernio-existing" },
      },
      {
        error: "A different conflict",
        details: { accountId: "acct-1", platform: "instagram", existingPostId: "zernio-existing" },
      },
    ]) {
      const { fetch: impl } = recordingFetch(() => json(body, 409));
      await expect(publishZernioInstagramReel(config, input, impl)).rejects.toThrow("409");
    }
  });

  it("fails loudly when the response carries no post id", async () => {
    const { fetch: impl } = recordingFetch(() => json({ platforms: [{ platform: "instagram", platformPostId: "ig-7" }] }));

    await expect(publishZernioInstagramReel(config, input, impl)).rejects.toThrow("Zernio did not return a post ID");
  });

  it("refuses to publish without an API key, and does not call out", async () => {
    const { fetch: impl, calls } = recordingFetch(() => json({ _id: "zernio-1" }));
    const noKey = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", CONTROLLER_BOT_TOKEN: "t" });

    await expect(publishZernioInstagramReel(noKey, input, impl)).rejects.toThrow("ZERNIO_API_KEY is missing");
    expect(calls).toEqual([]);
  });

  it("surfaces a provider rejection with its status and redacts the key from the message", async () => {
    // The key has to be in the body for the redaction assertion to mean anything.
    const { fetch: impl } = recordingFetch(
      () => new Response('{"error":"Bearer zernio-placeholder-not-a-secret rejected"}', { status: 422 }),
    );

    const error = await rejection(publishZernioInstagramReel(config, input, impl));
    expect(error.message).toContain("422");
    expect(error.message).not.toContain("zernio-placeholder-not-a-secret");
  });
});
