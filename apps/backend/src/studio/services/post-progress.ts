import { isSiteTarget, TARGETS } from "../../botTargets.js";
import { effectivePostTargets } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import { parseTargets } from "../../publishing/targets.js";

export type PostProgressStatus = "published" | "publishing" | "failed" | "verification_required" | "waiting" | "cancelled";
export type PostProgressState = {
  draftId: number;
  actorId: number;
  targets: Array<{ target: string; label: string; locale: "ru" | "en"; status: PostProgressStatus; error: string | null }>;
  counts: Record<PostProgressStatus, number>;
};

/** Transport-free progress read model shared by Telegram cards and future clients. */
export function postProgressState(backendDb: BackendDb, draftId: number): PostProgressState {
  const progress = backendDb.studioPosts.progress(draftId);
  if (!progress) throw new Error(`draft ${draftId} not found`);
  const statuses = new Map<string, { status: PostProgressStatus; error: string | null }>();
  for (const job of progress.publishJobs) statuses.set(job.target, normalize(job.status, job.lastError));
  for (const job of progress.siteJobs) {
    if (isSiteTarget(job.reason)) statuses.set(job.reason, normalize(job.status, job.lastError));
  }
  const targets = effectivePostTargets(backendDb, parseTargets(progress.draft.targetsJson));
  const items = TARGETS.filter(({ id }) => targets[id]).map(({ id: target, label, locale }) => {
    const current = statuses.get(target) ?? { status: "waiting" as const, error: null };
    return { target, label, locale, ...current };
  });
  const counts: Record<PostProgressStatus, number> = {
    published: 0,
    publishing: 0,
    failed: 0,
    verification_required: 0,
    waiting: 0,
    cancelled: 0,
  };
  for (const item of items) counts[item.status] += 1;
  return { draftId, actorId: progress.draft.actorId, targets: items, counts };
}

function normalize(status: string, error?: string | null): { status: PostProgressStatus; error: string | null } {
  if (status === "published" || status === "skipped") return { status: "published", error: null };
  if (status === "publishing") return { status: "publishing", error: null };
  if (status === "failed") return { status: "failed", error: error ?? null };
  if (status === "verification_required") return { status: "verification_required", error: error ?? null };
  if (status === "cancelled") return { status: "cancelled", error: null };
  return { status: "waiting", error: null };
}
