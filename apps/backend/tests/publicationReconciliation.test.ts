import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import {
  credentialChecks,
  drafts,
  publicationEvents,
  publicationPlans,
  publications,
  publicationTargets,
  publishJobs,
  siteJobs,
} from "../src/db/schema.js";
import { RECONCILE_MAX_ATTEMPTS, runPublicationReconciliation } from "../src/delivery/publication-reconciliation.js";
import { refreshPublicationStatus } from "../src/publishing/publication-status.js";
import { enqueuePublishJobTx } from "../src/publishing/queue.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

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
            publicationId: 90,
            publicationKey: "post:90",
            target: "threads_en",
            status: "published",
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
          {
            publicationId: 90,
            publicationKey: "post:90",
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

      const events = backendDb.db.select().from(publicationEvents).all();
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
          publicationId: 91,
          publicationKey: "post:91",
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
      expect(backendDb.db.select({ eventType: publicationEvents.eventType }).from(publicationEvents).all()).toHaveLength(1);
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, 91)).get()).toEqual({ status: "failed" });

      refreshPublicationStatus(backendDb, 91);
      expect(backendDb.db.select({ eventType: publicationEvents.eventType }).from(publicationEvents).all()).toHaveLength(1);
    }));

  it("announces the completion again once a retried target lands", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          id: 92,
          actorId: 42,
          status: "scheduled",
          textRu: "Retried post",
          targetsJson: JSON.stringify({ telegram_ru: true, instagram_stories: true }),
          postId: 92,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db.insert(publications).values({ postId: 92, draftId: 92, status: "scheduled", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(publishJobs)
        .values([
          {
            publicationId: 92,
            publicationKey: "post:92",
            target: "telegram_ru",
            status: "published",
            createdAt: now,
            updatedAt: now,
          },
          {
            publicationId: 92,
            publicationKey: "post:92",
            target: "instagram_stories",
            status: "failed",
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();

      refreshPublicationStatus(backendDb, 92);
      expect(completionEvents(backendDb)).toHaveLength(1);

      // The operator hits retry and the story lands minutes later: the second
      // completion is a different outcome, not a duplicate of the first.
      backendDb.db
        .update(publishJobs)
        .set({ status: "published" })
        .where(and(eq(publishJobs.publicationId, 92), eq(publishJobs.target, "instagram_stories")))
        .run();
      refreshPublicationStatus(backendDb, 92);

      const events = completionEvents(backendDb);
      expect(events).toHaveLength(2);
      expect(JSON.parse(events[1]?.detailsJson ?? "{}")).toMatchObject({ published: 2, failed: 0 });
      expect(backendDb.db.select({ status: drafts.status }).from(drafts).where(eq(drafts.id, 92)).get()).toEqual({ status: "published" });
    }));

  it("settles a publication that already has durable provider evidence", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationId: 81,
        publicationKey: "post:81",
        target: "threads_ru",
        payload: { text: "published" },
      });
      const now = new Date().toISOString();
      // One attempt short of the budget, so this cycle is the one that exhausts it.
      backendDb.db
        .update(publishJobs)
        .set({ status: "verification_required", reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS - 1, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:81",
          target: "threads_ru",
          status: "verification_required",
          externalId: "thread-81",
          updatedAt: now,
        })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-81", permalink: "https://www.threads.net/@owner/post/81" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "token" }), fetchImpl)).toMatchObject({
        checked: 1,
        resolved: 1,
        unresolved: 0,
      });
      expect(
        backendDb.db
          .select({
            status: publicationTargets.status,
            confirmationSource: publicationTargets.confirmationSource,
          })
          .from(publicationTargets)
          .where(and(eq(publicationTargets.publicationKey, "post:81"), eq(publicationTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ status: "published", confirmationSource: "provider_verify" });
    }));

  it("reconciles a Zernio Threads target through Zernio rather than treating its provider id as a Threads id", () =>
    withDb(async (backendDb) => {
      registerChannel(backendDb, {
        platform: "threads",
        locale: "ru",
        provider: "zernio",
        providerAccountId: "account-82",
        targetId: "threads_ru",
      });
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationId: 82,
        publicationKey: "post:82",
        target: "threads_ru",
        payload: { text: "published through Zernio" },
      });
      const now = new Date().toISOString();
      backendDb.db.update(publishJobs).set({ status: "verification_required", updatedAt: now }).where(eq(publishJobs.jobId, jobId)).run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:82",
          target: "threads_ru",
          status: "verification_required",
          externalId: "zernio-82",
          rawJson: JSON.stringify({ ok: true, providerPostId: "zernio-82" }),
          updatedAt: now,
        })
        .run();

      const requests: string[] = [];
      const fetchImpl = (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify({
            _id: "zernio-82",
            platforms: [{ platform: "threads", platformPostId: "thread-82", platformPostUrl: "https://threads.net/post/82" }],
          }),
          { status: 200 },
        );
      }) as unknown as typeof fetch;
      const config = Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "z".repeat(16) });

      expect(await runPublicationReconciliation(backendDb, config, fetchImpl)).toMatchObject({ checked: 1, resolved: 1 });
      expect(requests).toEqual(["https://zernio.com/api/v1/posts/zernio-82"]);
      expect(
        backendDb.db
          .select({ externalId: publicationTargets.externalId, url: publicationTargets.url })
          .from(publicationTargets)
          .where(and(eq(publicationTargets.publicationKey, "post:82"), eq(publicationTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ externalId: "thread-82", url: "https://threads.net/post/82" });
    }));

  it("polls a job that already spent its publish attempts", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationId: 83,
        publicationKey: "post:83",
        target: "threads_ru",
        payload: { text: "retried before it turned ambiguous" },
      });
      const now = new Date().toISOString();
      const config = loadTestConfig({ PUBLISH_MAX_ATTEMPTS: "3", THREADS_RU_ACCESS_TOKEN: "token" });
      backendDb.db
        .update(publishJobs)
        // Two failed publishes, then a lost confirmation: the publish budget is
        // nearly gone but nothing has ever asked the provider what happened.
        .set({ status: "verification_required", attemptCount: 3, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:83",
          target: "threads_ru",
          status: "verification_required",
          externalId: "thread-83",
          updatedAt: now,
        })
        .run();

      const fetchImpl = (async () =>
        new Response(JSON.stringify({ id: "thread-83", permalink: "https://www.threads.net/@owner/post/83" }), {
          status: 200,
        })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, config, fetchImpl)).toMatchObject({ checked: 1, resolved: 1 });
      expect(
        backendDb.db
          .select({ status: publicationTargets.status })
          .from(publicationTargets)
          .where(and(eq(publicationTargets.publicationKey, "post:83"), eq(publicationTargets.target, "threads_ru")))
          .get(),
      ).toEqual({ status: "published" });
    }));

  it("counts provider auth failures found during reconciliation", () =>
    withDb(async (backendDb) => {
      const jobId = enqueuePublishJobTx(backendDb.db, {
        publicationId: 84,
        publicationKey: "post:84",
        target: "threads_ru",
        payload: { text: "unknown outcome" },
      });
      const now = new Date().toISOString();
      // One attempt short of the budget, so this cycle is the one that exhausts it.
      backendDb.db
        .update(publishJobs)
        .set({ status: "verification_required", reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS - 1, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({
          publicationKey: "post:84",
          target: "threads_ru",
          status: "verification_required",
          externalId: "thread-84",
          updatedAt: now,
        })
        .run();

      const fetchImpl = (async () => new Response("expired token", { status: 401 })) as unknown as typeof fetch;
      expect(await runPublicationReconciliation(backendDb, loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "token" }), fetchImpl)).toMatchObject({
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
        publicationId: 82,
        publicationKey: "post:82",
        target: "telegram",
        payload: { text: "unknown" },
      });
      const now = new Date().toISOString();
      // One attempt short of the budget, so this cycle is the one that exhausts it.
      backendDb.db
        .update(publishJobs)
        .set({ status: "verification_required", reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS - 1, updatedAt: now })
        .where(eq(publishJobs.jobId, jobId))
        .run();
      backendDb.db
        .insert(publicationTargets)
        .values({ publicationKey: "post:82", target: "telegram", status: "verification_required", updatedAt: now })
        .run();

      const config = loadTestConfig();
      expect(await runPublicationReconciliation(backendDb, config)).toMatchObject({ checked: 1, resolved: 0, unresolved: 1 });
      expect(
        backendDb.db
          .select({ reconcileAttemptCount: publishJobs.reconcileAttemptCount, nextAttemptAt: publishJobs.nextAttemptAt })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, jobId))
          .get(),
      ).toEqual({ reconcileAttemptCount: RECONCILE_MAX_ATTEMPTS, nextAttemptAt: null });
      expect(
        backendDb.db
          .select({ eventType: publicationEvents.eventType })
          .from(publicationEvents)
          .where(eq(publicationEvents.eventType, "studio.notification.publication_verification_required"))
          .all(),
      ).toHaveLength(1);
      expect(await runPublicationReconciliation(backendDb, config)).toMatchObject({ checked: 0, unresolved: 1 });
      expect(
        backendDb.db
          .select({ eventType: publicationEvents.eventType })
          .from(publicationEvents)
          .where(eq(publicationEvents.eventType, "studio.notification.publication_verification_required"))
          .all(),
      ).toHaveLength(1);
    }));
});

function completionEvents(backendDb: Parameters<Parameters<typeof withDb>[0]>[0]) {
  return backendDb.db.select().from(publicationEvents).where(eq(publicationEvents.eventType, "delivery.post.completed")).all();
}
