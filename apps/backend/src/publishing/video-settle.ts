import { and, eq } from "drizzle-orm";
import { videoPublicUrl } from "../content/video-assets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoTargets } from "../db/schema.js";
import { publishZernioInstagramReel } from "../delivery/zernio.js";
import type { BackendConfig } from "../foundation/config.js";
import { getVideoDraft, refreshVideoDraftStatus } from "./video-data.js";
import type { InstagramMetadata } from "./video-types.js";

/**
 * Answers a provider-routed video target that is stuck in verification_required.
 *
 * A publish that lost its worker cannot be retried blindly — nobody knows
 * whether the audience already has it — and there was no way to ask, so the
 * target stayed unanswered while the operator could see it was probably never
 * sent. Asking is safe here for one specific reason: the provider fences the
 * publication by the request id derived from the target, so re-issuing it
 * returns the post that already exists rather than making a second one. The
 * answer settles the target either way.
 *
 * Deliberately provider-only. A native YouTube or Instagram upload has no such
 * fence, and re-sending one is how a video gets published twice.
 */
export async function settleVideoTarget(
  config: BackendConfig,
  backendDb: BackendDb,
  input: { videoDraftId: number; target: string; apply: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const row = unsafeDb(backendDb)
    .db.select()
    .from(videoTargets)
    .where(and(eq(videoTargets.videoDraftId, input.videoDraftId), eq(videoTargets.target, input.target)))
    .get();
  if (!row) throw new Error(`video:${input.videoDraftId} has no ${input.target} target`);
  // What this answers is "the provider has it, the platform link is unknown",
  // which a target wears either as verification_required or as a published row
  // with nothing to link to. Anything that already carries a link is settled.
  if (row.externalId || row.externalUrl) throw new Error(`${input.target} already has its platform publication`);
  if (row.status !== "verification_required" && row.status !== "published")
    throw new Error(`${input.target} is ${row.status}, and only a target awaiting its platform link is settled this way`);
  if (row.deliveryProvider !== "zernio")
    throw new Error(`${input.target} is delivered natively, which has no idempotent replay: settle it from what the platform shows`);
  const accountId = row.providerAccountId;
  if (!accountId) throw new Error(`${input.target} has no provider account id`);

  const draft = getVideoDraft(backendDb, input.videoDraftId);
  const requestId = `video-target:${row.id}`;
  const plan = { ref: `video:${input.videoDraftId}`, target: input.target, provider: "zernio", requestId, applied: false };
  if (!input.apply) return plan;

  const result = await publishZernioInstagramReel(
    config,
    { accountId, publicUrl: videoPublicUrl(backendDb, config, draft), metadata: row.metadataJson as InstagramMetadata, requestId },
    fetchImpl,
  );
  const now = new Date().toISOString();
  const settled = Boolean(result.externalId || result.url);
  // The provider publishes asynchronously, so a create that returns no platform
  // link is not finished — it is exactly the state the reconciliation loop
  // exists to close, and that loop only sees verification_required. Marking it
  // published here is how the link stopped arriving: the row left the only
  // sweep that could have filled it, carrying no link forever.
  unsafeDb(backendDb)
    .db.update(videoTargets)
    .set({
      status: settled ? "published" : "verification_required",
      providerPostId: result.providerPostId,
      externalId: result.externalId,
      externalUrl: result.url,
      publishedAt: row.publishedAt ?? (settled ? now : null),
      lastError: settled ? null : "awaiting the platform link from the provider",
      confirmationSource: settled ? "provider_verify" : "idempotency_replay",
      verifiedAt: settled ? now : null,
      updatedAt: now,
    })
    .where(eq(videoTargets.id, row.id))
    .run();
  refreshVideoDraftStatus(backendDb, input.videoDraftId, config.VIDEO_MEDIA_RETENTION_HOURS);
  return {
    ...plan,
    applied: true,
    providerPostId: result.providerPostId,
    externalId: result.externalId,
    url: result.url,
    status: settled ? "published" : "verification_required",
  };
}
