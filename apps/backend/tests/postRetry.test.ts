import { describe, expect, it } from "bun:test";
import { drafts, publicationEvents, publications, publicationTargets, publishJobs, siteJobs } from "../src/db/schema.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("post publication retry", () => {
  it("requeues failed social and site targets and refuses a second retry", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      backendDb.db
        .insert(drafts)
        .values({
          id: 7,
          actorId: 42,
          status: "failed",
          textRu: "Retryable post",
          targetsJson: JSON.stringify({ telegram: true, site_en: true }),
          postId: 700,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 700,
          publicationKey: "post:700",
          messageId: 700,
          target: "telegram",
          status: "failed",
          payloadJson: { text: "Retryable post" },
          attemptCount: 4,
          lastError: "Telegram timed out",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(publishJobs)
        .values({
          postId: 700,
          publicationKey: "post:700",
          messageId: 700,
          target: "threads_en",
          status: "verification_required",
          payloadJson: { text: "Retryable post" },
          attemptCount: 1,
          lastError: "Threads response was ambiguous",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      backendDb.db
        .insert(siteJobs)
        .values({
          postId: 700,
          messageId: 700,
          reason: "site_en",
          status: "verification_required",
          attemptCount: 2,
          lastError: "Site verification expired",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const posts = createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(backendDb.studioPosts.failedPublicationTargets(700).map((item) => item.target)).toEqual(["threads_en", "telegram", "site_en"]);

      expect(posts.retryTarget(42, 7)).toMatchObject({ requeued: 2, alreadyQueued: 0 });
      expect(
        backendDb.db
          .select({ target: publishJobs.target, status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .all(),
      ).toEqual([
        { target: "telegram", status: "queued", attemptCount: 0 },
        { target: "threads_en", status: "verification_required", attemptCount: 1 },
      ]);
      expect(backendDb.db.select({ status: siteJobs.status, attemptCount: siteJobs.attemptCount }).from(siteJobs).all()).toEqual([
        { status: "queued", attemptCount: 0 },
      ]);
      expect(
        backendDb.db.select({ target: publicationTargets.target, status: publicationTargets.status }).from(publicationTargets).all(),
      ).toEqual([
        { target: "telegram", status: "queued" },
        { target: "site_en", status: "queued" },
      ]);
      expect(() => posts.retryTarget(42, 7)).toThrow("err.retry-only-failed");
    }));

  it("abandons a target the operator skips and settles the publication without it", () =>
    withDb((backendDb) => {
      const now = new Date().toISOString();
      backendDb.db.insert(publications).values({ postId: 800, draftId: 8, status: "failed", createdAt: now, updatedAt: now }).run();
      backendDb.db
        .insert(drafts)
        .values({
          id: 8,
          actorId: 42,
          status: "failed",
          textRu: "Skippable post",
          targetsJson: JSON.stringify({ telegram: true, threads_ru: true }),
          postId: 800,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      for (const job of [
        { target: "telegram", status: "published", lastError: null },
        { target: "threads_ru", status: "failed", lastError: "Threads is unreachable" },
      ])
        backendDb.db
          .insert(publishJobs)
          .values({
            postId: 800,
            publicationKey: "post:800",
            messageId: 800,
            target: job.target,
            status: job.status,
            payloadJson: { text: "Skippable post" },
            attemptCount: 4,
            lastError: job.lastError,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      backendDb.db
        .insert(publicationTargets)
        .values([
          { publicationKey: "post:800", target: "telegram", status: "published", updatedAt: now },
          { publicationKey: "post:800", target: "threads_ru", status: "failed", updatedAt: now },
        ])
        .run();

      const posts = createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(posts.skipTarget(42, 8, "threads_ru")).toMatchObject({ abandoned: 1 });

      expect(backendDb.db.select({ target: publishJobs.target, status: publishJobs.status }).from(publishJobs).all()).toEqual([
        { target: "telegram", status: "published" },
        { target: "threads_ru", status: "cancelled" },
      ]);
      expect(
        backendDb.db.select({ target: publicationTargets.target, status: publicationTargets.status }).from(publicationTargets).all(),
      ).toEqual([
        { target: "telegram", status: "published" },
        { target: "threads_ru", status: "cancelled" },
      ]);
      // The publication no longer holds the draft in the attention list.
      expect(backendDb.db.select({ status: publications.status }).from(publications).all()).toEqual([{ status: "published" }]);
      expect(backendDb.studioQueue.failedPostIds([800])).toEqual([]);
      expect(
        backendDb.db.select({ type: publicationEvents.eventType, target: publicationEvents.target }).from(publicationEvents).all(),
      ).toContainEqual({
        type: "publish.target.abandoned",
        target: "threads_ru",
      });
      expect(() => posts.skipTarget(42, 8, "threads_ru")).toThrow("err.skip-only-failed");
    }));
});
