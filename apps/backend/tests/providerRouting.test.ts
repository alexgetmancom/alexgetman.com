import { describe, expect, it } from "bun:test";
import { registerChannel, targetRouting } from "../src/channels/registry.js";
import { createPlatformAdapters } from "../src/delivery/platform-adapters.js";
import { capabilityReport } from "../src/observability/capabilities.js";
import type { ClaimedPublishJob } from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const zernioConfig = Object.assign(loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "native-token" }), { ZERNIO_API_KEY: "z".repeat(16) });

function job(overrides: Record<string, unknown> = {}): ClaimedPublishJob {
  return {
    jobId: 7,
    target: "threads_ru",
    payload: { text: "hello", media: [{ type: "IMAGE", vpsUrl: "https://studio.example/media/a.jpg" }], ...overrides },
  } as unknown as ClaimedPublishJob;
}

function captureRequest() {
  const sent: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ _id: "zernio-post-1", platforms: [{ platformPostId: "p1", platformPostUrl: "https://t" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

describe("delivery through a provider", () => {
  it("routes a Threads channel connected through Zernio to the provider", async () => {
    // The registry has always carried a provider per channel, and only the video
    // pipeline read it: a Threads channel connected through Zernio still went to
    // Meta and still demanded a Meta token.
    const { sent, fetchImpl } = captureRequest();
    const adapters = createPlatformAdapters(zernioConfig, fetchImpl, async (job) => job, {
      threads_ru: { provider: "zernio", accountId: "acc-1" },
    });

    const result = await adapters.threads_ru?.publish(job());
    expect(result?.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain("zernio.com/api/v1/posts");
    const body = sent[0]?.body as { platforms: { platform: string; accountId: string }[]; mediaItems: unknown[] };
    expect(body.platforms[0]).toMatchObject({ platform: "threads", accountId: "acc-1" });
    expect(body.mediaItems).toHaveLength(1);
  });

  it("sends an Instagram Story as a story, with one visual", async () => {
    const { sent, fetchImpl } = captureRequest();
    const adapters = createPlatformAdapters(zernioConfig, fetchImpl, async (job) => job, {
      instagram_stories_ru: { provider: "zernio", accountId: "acc-2" },
    });

    await adapters.instagram_stories_ru?.publish(
      job({
        media: [
          { type: "IMAGE", vpsUrl: "https://studio.example/media/story.jpg" },
          { type: "IMAGE", vpsUrl: "https://studio.example/media/extra.jpg" },
        ],
      }),
    );
    const body = sent[0]?.body as {
      platforms: { platform: string; platformSpecificData?: { contentType?: string } }[];
      mediaItems: unknown[];
    };
    expect(body.platforms[0]?.platform).toBe("instagram");
    expect(body.platforms[0]?.platformSpecificData?.contentType).toBe("story");
    // A Story is one visual; the rest of an album belongs to feed targets.
    expect(body.mediaItems).toHaveLength(1);
  });

  it("refuses a story with nothing to show rather than posting an empty one", async () => {
    const { sent, fetchImpl } = captureRequest();
    const adapters = createPlatformAdapters(zernioConfig, fetchImpl, async (job) => job, {
      instagram_stories_ru: { provider: "zernio", accountId: "acc-2" },
    });

    const result = await adapters.instagram_stories_ru?.publish(job({ media: [] }));
    expect(result?.error).toBe("story_media_missing");
    expect(sent).toHaveLength(0);
  });

  it("still publishes natively when no provider carries the target", async () => {
    const { sent, fetchImpl } = captureRequest();
    const adapters = createPlatformAdapters(zernioConfig, fetchImpl, async (job) => job, {});

    await adapters.threads_ru?.publish(job()).catch(() => undefined);
    expect(sent.every((request) => !request.url.includes("zernio.com"))).toBe(true);
  });

  it("asks for the provider key instead of the platform's tokens", () =>
    withDb((backendDb) => {
      registerChannel(backendDb, { platform: "threads", locale: "ru", provider: "zernio", targetId: "threads_ru" });
      registerChannel(backendDb, { platform: "threads", locale: "en", provider: "native", targetId: "threads_en" });

      const report = new Map(capabilityReport(loadTestConfig({}), backendDb).map((entry) => [entry.target, entry.required]));
      expect(report.get("threads_ru")).toEqual(["ZERNIO_API_KEY"]);
      expect(report.get("threads_en")).toEqual(["THREADS_EN_ACCESS_TOKEN"]);

      expect(targetRouting(backendDb).threads_ru).toEqual({ provider: "zernio", accountId: null });
    }));
});
