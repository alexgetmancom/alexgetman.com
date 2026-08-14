import { describe, expect, it } from "bun:test";
import { drafts, postTargets, publishJobs, siteJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { withDb } from "./helpers/db.js";

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
          postKey: "post:700",
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
          postKey: "post:700",
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

      const posts = createStudioServices(backendDb, loadConfig({ CONTROLLER_ADMIN_IDS: "42" })).posts;
      expect(backendDb.studioPosts.retryablePublicationTargets(700).map((item) => item.target)).toEqual(["telegram", "site_en"]);

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
      expect(backendDb.db.select({ target: postTargets.target, status: postTargets.status }).from(postTargets).all()).toEqual([
        { target: "telegram", status: "queued" },
        { target: "site_en", status: "queued" },
      ]);
      expect(() => posts.retryTarget(42, 7)).toThrow("err.retry-only-failed");
    }));
});
