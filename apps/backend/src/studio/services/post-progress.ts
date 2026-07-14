import { eq } from "drizzle-orm";
import { TARGETS } from "../../botTargets.js";
import type { BackendDb } from "../../db/client.js";
import { drafts, publishJobs, siteJobs } from "../../db/schema.js";
import { parseTargets } from "../../publishing/targets.js";

export type PostProgressStatus = "published" | "publishing" | "failed" | "waiting" | "cancelled";
export type PostProgressState = {
  draftId: number;
  adminId: number;
  targets: Array<{ target: string; label: string; locale: "ru" | "en"; status: PostProgressStatus; error: string | null }>;
  counts: Record<PostProgressStatus, number>;
};

/** Transport-free progress read model shared by Telegram cards and future clients. */
export function postProgressState(backendDb: BackendDb, draftId: number): PostProgressState {
  const draft = backendDb.db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  const statuses = new Map<string, { status: PostProgressStatus; error: string | null }>();
  if (draft.postId != null) {
    for (const job of backendDb.db.select().from(publishJobs).where(eq(publishJobs.postId, draft.postId)).all())
      statuses.set(job.target, normalize(job.status, job.lastError));
    for (const job of backendDb.db.select().from(siteJobs).where(eq(siteJobs.postId, draft.postId)).all())
      statuses.set(job.reason === "publish_ru" ? "site_ru" : "site_en", normalize(job.status, job.lastError));
  }
  const targets = parseTargets(draft.targetsJson);
  const items = TARGETS.filter(([target]) => targets[target]).map(([target, label, locale]) => {
    const current = statuses.get(target) ?? { status: "waiting" as const, error: null };
    return { target, label, locale, ...current };
  });
  const counts: Record<PostProgressStatus, number> = { published: 0, publishing: 0, failed: 0, waiting: 0, cancelled: 0 };
  for (const item of items) counts[item.status] += 1;
  return { draftId, adminId: draft.adminId, targets: items, counts };
}

function normalize(status: string, error?: string | null): { status: PostProgressStatus; error: string | null } {
  if (status === "published" || status === "skipped") return { status: "published", error: null };
  if (status === "publishing") return { status: "publishing", error: null };
  if (status === "failed") return { status: "failed", error: error ?? null };
  if (status === "cancelled") return { status: "cancelled", error: null };
  return { status: "waiting", error: null };
}
