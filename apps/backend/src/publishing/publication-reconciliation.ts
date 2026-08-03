import { eq } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { drafts, publications, publishJobs, siteJobs } from "../db/schema.js";
import { publicationStatus } from "./state.js";

/** Reconciles target jobs into one publication state. Queue mechanics do not own this read model. */
export function reconcilePublication(backendDb: BackendDb, postId: number): void {
  const existing = backendDb.db.select({ status: publications.status }).from(publications).where(eq(publications.postId, postId)).get();
  if (existing?.status === "cancelled") return;
  const social = backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.postId, postId)).all();
  const site = backendDb.db.select({ status: siteJobs.status }).from(siteJobs).where(eq(siteJobs.postId, postId)).all();
  const all = [...social, ...site];
  const status = publicationStatus(all.map((job) => job.status));
  if (!status) return;
  const now = backendDb.clock.now().toISOString();
  backendDb.db.transaction((tx) => {
    tx.update(publications).set({ status, updatedAt: now }).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ status, updatedAt: now }).where(eq(drafts.postId, postId)).run();
  });
}
