import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { type BackendDb, type UnsafeBackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts, videoJobs, videoTargets } from "../db/schema.js";
import { StudioError } from "../foundation/errors.js";
import { isVideoTargetFinal, videoDraftStatus } from "./state.js";

type VideoDraft = typeof videoDrafts.$inferSelect;
type VideoTargetRow = typeof videoTargets.$inferSelect;
export type VideoJob = typeof videoJobs.$inferSelect;
type VideoJobKind = "prepare" | "publish" | "reminder";

export function getVideoDraft(backendDb: BackendDb, id: number): VideoDraft {
  const draft = unsafeDb(backendDb).db.select().from(videoDrafts).where(eq(videoDrafts.id, id)).get();
  if (!draft) throw new Error("Video publication was not found.");
  return draft;
}

export function listVideoTargets(backendDb: BackendDb, videoDraftId: number): VideoTargetRow[] {
  return unsafeDb(backendDb)
    .db.select()
    .from(videoTargets)
    .where(eq(videoTargets.videoDraftId, videoDraftId))
    .orderBy(asc(videoTargets.id))
    .all();
}

export function insertVideoJob(
  tx: UnsafeBackendDb["db"],
  videoDraftId: number,
  videoTargetId: number | null,
  kind: VideoJobKind,
  runAt: string,
): void {
  const exists = tx
    .select({ id: videoJobs.id })
    .from(videoJobs)
    .where(
      and(
        eq(videoJobs.videoDraftId, videoDraftId),
        videoTargetId == null ? isNull(videoJobs.videoTargetId) : eq(videoJobs.videoTargetId, videoTargetId),
        eq(videoJobs.kind, kind),
      ),
    )
    .get();
  const now = new Date().toISOString();
  if (exists) {
    // Never clear lockedBy while a worker still holds it. The video worker
    // fences every completion on (id, lockedBy); stealing the lock here would
    // turn its completion write into a no-op while the target itself was
    // already marked published, and the requeued job would publish twice.
    const requeued = tx
      .update(videoJobs)
      .set({
        runAt,
        status: "queued",
        attemptCount: 0,
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(videoJobs.id, exists.id), ne(videoJobs.status, "running")))
      .returning({ id: videoJobs.id })
      .get();
    if (!requeued) throw new StudioError("err.video-job-running");
  } else
    tx.insert(videoJobs)
      .values({
        videoDraftId,
        videoTargetId,
        kind,
        runAt,
        createdAt: now,
        updatedAt: now,
      })
      .run();
}

export function refreshVideoDraftStatus(backendDb: BackendDb, videoDraftId: number, retentionHours: number): void {
  const targets = listVideoTargets(backendDb, videoDraftId);
  if (targets.length === 0) return;
  const final = targets.every((target) => isVideoTargetFinal(target.status));
  const status = videoDraftStatus(targets.map((target) => target.status));
  unsafeDb(backendDb)
    .db.update(videoDrafts)
    .set({
      status,
      retentionUntil: final ? new Date(Date.now() + retentionHours * 60 * 60_000).toISOString() : null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(videoDrafts.id, videoDraftId))
    .run();
}
