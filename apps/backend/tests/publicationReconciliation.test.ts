import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  credentialChecks,
  drafts,
  postEvents,
  postTargets,
  publicationPlans,
  publications,
  publishJobs,
  siteJobs,
} from "../src/db/schema.js";
import { runPublicationReconciliation } from "../src/delivery/publication-reconciliation.js";
import { loadConfig } from "../src/foundation/config.js";
import { refreshPublicationStatus } from "../src/publishing/publication-status.js";
import { enqueuePublishJobTx } from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";

describe("publication reconciliation", () => {
  it("emits one completion event for an earlier locale while a later locale waits", () =>
    withDb((backendDb) => {
      const now = new Date("2026-08-05T21:32:13.000Z");
      const later = new Date("2026-08-06T07:00:00.000Z");
      backendDb.db
        .insert(drafts)
        .values({
          id: 90,
          actorId: 42,
          status: "scheduled",
          textRu: "RU",
          textEnMachine: "EN",
          targetsJson: JSON.stringify({ telegram: true, site_ru: true, threads_en: true, site_en: true }),
          postId: 90,
          scheduledAt: later.toISOString(),
          scheduledEnAt: now.toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
      backendDb.db
        .insert(publications)
        .values({ postId: 90, draftId: 90, status: "scheduled", createdAt: now.toISOString(), updatedAt: now.toISOString() })
        .run();
      backendDb.db
        .insert(publicationPlans)
        .values({
          postId: 90,
          planJson: {
            mode: "scheduled",
            targets: { telegram: true, site_ru: true, threads_en: true, site_en: true },
            scheduled_at: later.toISOString(),
            scheduled_en_at: now.toISOString(),
          },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values([
          {
            postId: 90,
            postKey: "post:90",
            messageId: 90,
            target: "threads_en",
            status: "published",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            postId: 90,
            postKey: "post:90",
            messageId: 90,
            target: "telegram",
            status: "queued",
            publishAt: later.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ])
        .run();
      backendDb.db
        .insert(siteJobs)
        .values([
          {
            postId: 90,
            messageId: 90,
            reason: "site_en",
            status: "published",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            postId: 90,
            messageId: 90,
            reason: "site_ru",
            status: "queued",
            nextAttemptAt: later.toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ])
        .run();

      refreshPublicationStatus(backendDb, 90);
      refreshPublicationStatus(backendDb, 90);

      const events = backendDb.db.select().from(postEvents).all();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: "delivery.post.locale.completed", target: "en" });
      expect(JSON.parse(events[0]?.detailsJson ?? "{}")).toMatchObject({
        locale: "en",
        published: 2,
        remaining: [{ locale: "ru", scheduled_at: later.toISOString() }],
      });
    }));

  it("emits one aggregate when social and site targets are terminal", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          id: 91,
          actorId: 42,
          status: "scheduled",
          textRu: "Terminal post",
          targetsJson: JSON.stringify({ telegram_ru: true, site_en: true }),
          postId: 91,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db.insert(publications).values({ postId: 91, draftId: 91, status: "scheduled", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 91,
          postKey: "post:91",
          messageId: 91,
          target: "telegram_ru",
          status: "failed",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({ postId: 91, messageId: 91, reason: "site_en", status: "published", createdAt: now, updatedAt: now })
        .run();

      refreshPublicationStatus(backendDb, 91);
      expect(backendDb.db.select({ eventType: postEvents.eventType }).from(postEvents).all()).toHaveLength(1);
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, 91)).get()).toEqual({ status: "failed" });

      refreshPublicationStatus(backendDb, 91);
      expect(backendDb.db.select({ eventType: postEvents.eventType }).from(postEvents).all()).toHaveLength(1);
    }));

  it("settles a publication that already has durable provider evidence", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 81,
        postKey: "post:81",
        messageId: 81,
        target: "threads_ru",
        payload: { text: "published" },
      });
      const now = new Date().toISOString();
      backendDb.db.update(publishJobs).set({ status: "verification_required", updatedAt: now }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:81", target: "threads_ru", status: "verification_required", externalId: "thread-81", updatedAt: now })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-81", permalink: "https://www.threads.net/@owner/post/81" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadConfig({ THREADS_RU_ACCESS_TOKEN: "token" }), fetchImpl)).toMatchObject({
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
          .where(and(eq(postTargets.postKey, "post:81"), eq(postTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ status: "published", confirmationSource: "provider_verify" });
    }));

  it("polls a job that already spent its publish attempts", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 83,
        postKey: "post:83",
        messageId: 83,
        target: "threads_ru",
        payload: { text: "retried before it turned ambiguous" },
      });
      const now = new Date().toISOString();
      const config = loadConfig({ PUBLISH_MAX_ATTEMPTS: "3", THREADS_RU_ACCESS_TOKEN: "token" });
      backendDb.db
        .update(publishJobs)
        // Two failed publishes, then a lost confirmation: the publish budget is
        // nearly gone but nothing has ever asked the provider what happened.
        .set({ status: "verification_required", attemptCount: 3, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:83", target: "threads_ru", status: "verification_required", externalId: "thread-83", updatedAt: now })
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
          .where(and(eq(postTargets.postKey, "post:83"), eq(postTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ status: "published" });
    }));

  it("counts provider auth failures found during reconciliation", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        postId: 84,
        postKey: "post:84",
        messageId: 84,
        target: "threads_ru",
        payload: { text: "unknown outcome" },
      });
      const now = new Date().toISOString();
      backendDb.db.update(publishJobs).set({ status: "verification_required", updatedAt: now }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(postTargets)
        .values({ postKey: "post:84", target: "threads_ru", status: "verification_required", externalId: "thread-84", updatedAt: now })
        .run();

      const fetchImpl = (async () => new Response("expired token", { status: 401 })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadConfig({ THREADS_RU_ACCESS_TOKEN: "token" }), fetchImpl)).toMatchObject({
        checked: 1,
        resolved: 0,
        unresolved: 1,
      });
      const check = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "threads_ru")).get();
      expect(JSON.parse(check?.detailsJson ?? "{}")).toMatchObject({ authFailureStreak: 1 });
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
