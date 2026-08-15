import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { videoTargets } from "../src/db/schema.js";
import { replaceVideoTargets, saveVideoMetadata } from "../src/publishing/video-service.js";
import { settleVideoTarget } from "../src/publishing/video-settle.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

const config = Object.assign(loadTestConfig({ PUBLIC_BASE_URL: "https://maru.example" }), { ZERNIO_API_KEY: "z".repeat(16) });

function transport(post: Record<string, unknown>) {
  const calls: Array<{ url: string; requestId: string | null }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), requestId: new Headers(init?.headers).get("x-request-id") });
    return Response.json(post);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stuckReel(backendDb: UnsafeBackendDb): number {
  registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "zernio", providerAccountId: "maru-account" });
  const draftId = createTestVideoDraft(backendDb, 42, "/tmp/reel.mp4", 24);
  replaceVideoTargets(backendDb, draftId, ["instagram_reels"] as never);
  saveVideoMetadata(backendDb, draftId, "instagram_reels", { caption: "Clip" });
  backendDb.sqlite
    .prepare(
      "UPDATE video_targets SET status='verification_required', delivery_provider='zernio', provider_account_id='maru-account', last_error='worker_lost: video lock expired before completion'",
    )
    .run();
  return draftId;
}

describe("answering a video publication that lost its worker", () => {
  it("asks the provider with the fenced request id and settles what came back", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      const { fetchImpl, calls } = transport({
        _id: "zernio-post",
        platforms: [{ platform: "instagram", platformPostId: "ig-1", platformPostUrl: "https://instagram.com/reel/ig-1" }],
      });

      const result = await settleVideoTarget(
        config,
        backendDb,
        { videoDraftId: draftId, target: "instagram_reels", apply: true },
        fetchImpl,
      );

      expect(result.status).toBe("published");
      expect(calls[0]?.requestId).toStartWith("video-target:");
      const row = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
      expect(row).toMatchObject({ status: "published", externalId: "ig-1", providerPostId: "zernio-post" });
      expect(row?.verifiedAt).not.toBeNull();
    }));

  it("keeps a publication the platform has not confirmed inside the sweep that can confirm it", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      // The provider publishes asynchronously: a create with no platform link is
      // unfinished. Calling it published took the row out of the reconciliation
      // sweep — the only thing that fills the link — and it stayed linkless.
      const { fetchImpl } = transport({ _id: "zernio-post" });

      const result = await settleVideoTarget(
        config,
        backendDb,
        { videoDraftId: draftId, target: "instagram_reels", apply: true },
        fetchImpl,
      );

      expect(result.status).toBe("verification_required");
      const row = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
      expect(row).toMatchObject({ status: "verification_required", providerPostId: "zernio-post", externalId: null });
    }));

  it("refuses a target that already carries its platform publication", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      backendDb.sqlite.prepare("UPDATE video_targets SET status='published', external_id='ig-1'").run();
      const { fetchImpl, calls } = transport({ _id: "zernio-post" });

      await expect(
        settleVideoTarget(config, backendDb, { videoDraftId: draftId, target: "instagram_reels", apply: true }, fetchImpl),
      ).rejects.toThrow("already has its platform publication");
      expect(calls).toEqual([]);
    }));
});
