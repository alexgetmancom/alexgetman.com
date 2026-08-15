import { and, desc, eq } from "drizzle-orm";
import { videoPublicUrl } from "../content/video-assets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoJobs, videoTargets } from "../db/schema.js";
import { publishZernioInstagramReel, zernioPostOutcome } from "../delivery/zernio.js";
import type { BackendConfig } from "../foundation/config.js";
import { getVideoDraft, refreshVideoDraftStatus } from "./video-data.js";
import { zernioPublishFence } from "./video-fence.js";
import type { InstagramMetadata } from "./video-types.js";

/**
 * Asks the provider what became of a video publication whose outcome this
 * Studio never learned, and records the answer.
 *
 * A publish that lost its worker cannot be retried blindly — nobody knows
 * whether the audience already has it — so the target sat unanswered with no
 * way to ask. Asking is safe because the publication is fenced by its job's
 * request id: re-issuing it returns the post the provider already made rather
 * than making a second one.
 *
 * Three answers, three states. The platform link means published. A provider-side
 * failure means the audience got nothing, so the target goes back to `failed`
 * where the ordinary retry can pick it up — and that retry, being a new job,
 * carries a new fence and can create the publication this attempt never made.
 * Anything else is still in flight and stays in verification_required, which is
 * the only state the reconciliation sweep watches.
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
  // What this answers is "the provider took it, the platform has not confirmed",
  // which a target wears either as verification_required or as a published row
  // with nothing to link to. Anything carrying a link is already settled.
  if (row.externalId || row.externalUrl) throw new Error(`${input.target} already has its platform publication`);
  if (row.status !== "verification_required" && row.status !== "published")
    throw new Error(`${input.target} is ${row.status}, and only a target awaiting its platform link is settled this way`);
  if (row.deliveryProvider !== "zernio")
    throw new Error(`${input.target} is delivered natively, which has no idempotent replay: settle it from what the platform shows`);
  const accountId = row.providerAccountId;
  if (!accountId) throw new Error(`${input.target} has no provider account id`);

  const publishJob = unsafeDb(backendDb)
    .db.select({ id: videoJobs.id, runAt: videoJobs.runAt })
    .from(videoJobs)
    .where(and(eq(videoJobs.videoTargetId, row.id), eq(videoJobs.kind, "publish")))
    .orderBy(desc(videoJobs.id))
    .get();
  if (!publishJob) throw new Error(`${input.target} has no publish job to ask about`);
  const requestId = zernioPublishFence(publishJob);
  const plan = { ref: `video:${input.videoDraftId}`, target: input.target, provider: "zernio", requestId, applied: false };
  if (!input.apply) return plan;

  // A publication we already know the id of is asked about; one we do not is
  // asked for, under the fence that makes asking indistinguishable from having
  // asked before.
  const result = row.providerPostId
    ? await zernioPostOutcome(config, row.providerPostId, fetchImpl)
    : {
        ...(await publishZernioInstagramReel(
          config,
          {
            accountId,
            publicUrl: videoPublicUrl(backendDb, config, getVideoDraft(backendDb, input.videoDraftId)),
            metadata: row.metadataJson as InstagramMetadata,
            requestId,
          },
          fetchImpl,
        )),
        failure: null as string | null,
      };

  const now = new Date().toISOString();
  const landed = Boolean(result.externalId || result.url);
  const status = landed ? "published" : result.failure ? "failed" : "verification_required";
  unsafeDb(backendDb)
    .db.update(videoTargets)
    .set({
      status,
      providerPostId: result.providerPostId,
      externalId: result.externalId,
      externalUrl: result.url,
      publishedAt: landed ? (row.publishedAt ?? now) : null,
      lastError: landed ? null : (result.failure ?? "awaiting the platform link from the provider"),
      confirmationSource: landed ? "provider_verify" : "idempotency_replay",
      verifiedAt: landed ? now : null,
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
    failure: result.failure,
    status,
  };
}
