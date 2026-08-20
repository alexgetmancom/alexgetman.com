import { eq } from "drizzle-orm";
import { publicationRef } from "../application/publication-ref.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { articles, publishJobs } from "../db/schema.js";
import { publicationStatus } from "./state.js";

/** Folds an article's target jobs into its one status.
 *
 * The post version of this rule (publication-status.ts) also weighs a schedule
 * plan and site jobs, because a post can hold a locale back for a later date.
 * An article is queued for the targets it is queued for; nothing else can leave
 * it unfinished, so the shared `publicationStatus` fold is the whole rule. */
export function refreshArticleStatus(backendDb: BackendDb, articleId: number): void {
  const key = publicationRef("article", articleId);
  const statuses = unsafeDb(backendDb)
    .db.select({ status: publishJobs.status })
    .from(publishJobs)
    .where(eq(publishJobs.publicationKey, key))
    .all()
    .map((job) => job.status);
  const status = publicationStatus(statuses);
  if (!status) return;
  unsafeDb(backendDb).db.update(articles).set({ status, updatedAt: new Date().toISOString() }).where(eq(articles.id, articleId)).run();
}
