import { eq } from "drizzle-orm";
import { targetLocale } from "../botTargets.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { drafts, publicationPlans, publications, publishJobs, siteJobs } from "../db/schema.js";
import { publicationStatus } from "./state.js";

/** Reconciles target jobs into one publication state. Queue mechanics do not own this read model. */
export function reconcilePublication(backendDb: BackendDb, postId: number): void {
  const existing = unsafeDb(backendDb)
    .db.select({ status: publications.status })
    .from(publications)
    .where(eq(publications.postId, postId))
    .get();
  if (existing?.status === "cancelled") return;
  const social = unsafeDb(backendDb)
    .db.select({ status: publishJobs.status })
    .from(publishJobs)
    .where(eq(publishJobs.postId, postId))
    .all();
  const site = unsafeDb(backendDb).db.select({ status: siteJobs.status }).from(siteJobs).where(eq(siteJobs.postId, postId)).all();
  const all = [...social, ...site];
  const status = publicationStatus(all.map((job) => job.status));
  if (!status) return;
  const effectiveStatus = status === "published" && hasPendingLocaleSchedule(backendDb, postId) ? "scheduled" : status;
  const now = backendDb.clock.now().toISOString();
  unsafeDb(backendDb).db.transaction((tx) => {
    tx.update(publications).set({ status: effectiveStatus, updatedAt: now }).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ status: effectiveStatus, updatedAt: now }).where(eq(drafts.postId, postId)).run();
  });
}

/** A scheduled post may intentionally have one locale waiting for a later
 * operator choice. That missing locale is not an immediate target and must
 * keep the publication open after the already scheduled locale settles. */
function hasPendingLocaleSchedule(backendDb: BackendDb, postId: number): boolean {
  const planJson = unsafeDb(backendDb)
    .db.select({ planJson: publicationPlans.planJson })
    .from(publicationPlans)
    .where(eq(publicationPlans.postId, postId))
    .get()?.planJson;
  if (!planJson || typeof planJson !== "object" || Array.isArray(planJson) || planJson.mode !== "scheduled") return false;
  const targets = planJson.targets;
  if (!targets || typeof targets !== "object" || Array.isArray(targets)) return false;
  return Object.entries(targets).some(([target, enabled]) => {
    if (!enabled) return false;
    const locale = targetLocale(target);
    if (!locale) return false;
    const scheduleKey = locale === "en" ? "scheduled_en_at" : "scheduled_at";
    return typeof planJson[scheduleKey] !== "string" || !planJson[scheduleKey];
  });
}
