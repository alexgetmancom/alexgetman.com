import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { postEvents, postTargets, publishJobs } from "../src/db/schema.js";
import { runPublicationReconciliation } from "../src/delivery/publication-reconciliation.js";
import { loadConfig } from "../src/foundation/config.js";
import { enqueuePublishJobTx } from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";

describe("publication reconciliation", () => {
  it("settles a publication that already has durable provider evidence", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 81,
        postKey: "post:81",
        messageId: 81,
        target: "threads",
        payload: { text: "published" },
      });
      const now = new Date().toISOString();
      backendDb.db.update(publishJobs).set({ status: "verification_required", updatedAt: now }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:81", target: "threads", status: "verification_required", externalId: "thread-81", updatedAt: now })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-81", permalink: "https://www.threads.net/@owner/post/81" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadConfig({}), fetchImpl)).toMatchObject({
        checked: 1,
        resolved: 1,
        unresolved: 0,
      });
      expect(
        backendDb.db
          .select({
            status: postTargets.status,
            confirmationSource: postTargets.confirmationSource,
          })
          .from(postTargets)
          .where(and(eq(postTargets.postKey, "post:81"), eq(postTargets.target, "threads")))
          .get(),
      ).toEqual({ status: "published", confirmationSource: "provider_verify" });
    }));

  it("polls a job that already spent its publish attempts", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 83,
        postKey: "post:83",
        messageId: 83,
        target: "threads",
        payload: { text: "retried before it turned ambiguous" },
      });
      const now = new Date().toISOString();
      const config = loadConfig({ PUBLISH_MAX_ATTEMPTS: "3" });
      backendDb.db
        .update(publishJobs)
        // Two failed publishes, then a lost confirmation: the publish budget is
        // nearly gone but nothing has ever asked the provider what happened.
        .set({ status: "verification_required", attemptCount: 3, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:83", target: "threads", status: "verification_required", externalId: "thread-83", updatedAt: now })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-83", permalink: "https://www.threads.net/@owner/post/83" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, config, fetchImpl)).toMatchObject({ checked: 1, resolved: 1 });
      expect(
        backendDb.db
          .select({ status: postTargets.status })
          .from(postTargets)
          .where(and(eq(postTargets.postKey, "post:83"), eq(postTargets.target, "threads")))
          .get(),
      ).toEqual({ status: "published" });
    }));

  it("keeps an id-less result unresolved and emits one owner-visible summary", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 82,
        postKey: "post:82",
        messageId: 82,
        target: "telegram",
        payload: { text: "unknown" },
      });
      const now = new Date().toISOString();
      backendDb.db.update(publishJobs).set({ status: "verification_required", updatedAt: now }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:82", target: "telegram", status: "verification_required", updatedAt: now })
        .run();

      const config = loadConfig({ RECONCILE_MAX_ATTEMPTS: "1" });
      expect(await runPublicationReconciliation(backendDb, config)).toMatchObject({ checked: 1, resolved: 0, unresolved: 1 });
      expect(
        backendDb.db
          .select({ reconcileAttemptCount: publishJobs.reconcileAttemptCount, nextAttemptAt: publishJobs.nextAttemptAt })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, jobId))
          .get(),
      ).toEqual({ reconcileAttemptCount: 1, nextAttemptAt: null });
      expect(
        backendDb.db
          .select({ eventType: postEvents.eventType })
          .from(postEvents)
          .where(eq(postEvents.eventType, "studio.notification.publication_verification_required"))
          .all(),
      ).toHaveLength(1);
      expect(await runPublicationReconciliation(backendDb, config)).toMatchObject({ checked: 0, unresolved: 1 });
      expect(
        backendDb.db
          .select({ eventType: postEvents.eventType })
          .from(postEvents)
          .where(eq(postEvents.eventType, "studio.notification.publication_verification_required"))
          .all(),
      ).toHaveLength(1);
    }));
});
