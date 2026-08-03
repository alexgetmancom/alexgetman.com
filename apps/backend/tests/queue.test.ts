import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { openBackendDb } from "../src/db/client.js";
import { type JsonObject, postEvents, postTargets, publishJobs } from "../src/db/schema.js";
import { AmbiguousPublicationError } from "../src/delivery/ambiguous-publication.js";
import { type DeliveryAdapter, type DeliveryPorts, type DeliveryPublisher, deliveryAdapter } from "../src/delivery/ports.js";
import { loadConfig } from "../src/foundation/config.js";
import { HttpPublishError } from "../src/publishing/errors.js";
import {
  claimDuePublishJobs,
  completePublishJob,
  enqueuePublishJobTx,
  failPublishJob,
  recoverStalePublishJobs,
} from "../src/publishing/queue.js";
import { runPublishCycle, runPublishWatchdog } from "../src/runtime/workers.js";
import { withDb } from "./helpers/db.js";

/** Test-only convenience over enqueuePublishJobTx: derives a postId/postKey from
 * messageId so queue-mechanics tests don't need a real publication behind each job. */
function enqueuePublishJob(
  backendDb: ReturnType<typeof openBackendDb>,
  input: { messageId: number; target: string; payload: JsonObject; publishAt?: string | null },
): number {
  return enqueuePublishJobTx(backendDb.db, {
    ...input,
    postId: input.messageId,
    postKey: `post:${input.messageId}`,
  });
}

function testAdapter(publish: DeliveryPublisher, hooks: Partial<Pick<DeliveryAdapter, "prepare">> = {}): DeliveryAdapter {
  return deliveryAdapter(publish, {
    validate: async () => undefined,
    verify: async (_job, result) => result,
    ...hooks,
  });
}

function testPorts(entries: Record<string, DeliveryPublisher | DeliveryAdapter>): DeliveryPorts {
  return Object.fromEntries(
    Object.entries(entries).map(([target, entry]) => [target, typeof entry === "function" ? testAdapter(entry) : entry]),
  ) as DeliveryPorts;
}

describe("publish queue", () => {
  it("does not let a stale worker fail a job claimed by another worker", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 90,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const [claimed] = claimDuePublishJobs(backendDb, 1, "active-worker");
      if (!claimed) throw new Error("job was not claimed");

      failPublishJob(backendDb, loadConfig({}), id, new HttpPublishError("server error", 503), "stale-worker");

      expect(
        backendDb.db
          .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({
        status: "publishing",
        lockedBy: "active-worker",
      });
    }));

  it("retries a transient failed job while preserving its published external id", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 91,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const [claimed] = claimDuePublishJobs(backendDb, 1, "active-worker");
      if (!claimed) throw new Error("job was not claimed");
      backendDb.db.update(postTargets).set({ externalId: "existing-id" }).where(eq(postTargets.target, "test_platform")).run();

      failPublishJob(
        backendDb,
        loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }),
        id,
        new HttpPublishError("server error", 503),
        claimed.lockId,
      );

      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({
        status: "queued",
        attemptCount: 1,
      });
      expect(
        backendDb.db
          .select({ status: postTargets.status, externalId: postTargets.externalId })
          .from(postTargets)
          .where(eq(postTargets.target, "test_platform"))
          .get(),
      ).toEqual({
        status: "queued",
        externalId: "existing-id",
      });
    }));

  it("claims queued publish jobs and marks target publishing", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 100,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const [job] = claimDuePublishJobs(backendDb, 10, "test-worker");
      expect(job).toMatchObject({ jobId: id, messageId: 100, target: "test_platform" });
      const row = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(row).toEqual({ status: "publishing", lockedBy: "test-worker" });
      const target = backendDb.db
        .select({ status: postTargets.status })
        .from(postTargets)
        .where(eq(postTargets.target, "test_platform"))
        .get();
      if (!target) throw new Error("expected post target");
      expect(target.status).toBe("publishing");
    }));

  it("does not claim a scheduled job before its publish time and executes it when due", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 99,
        target: "test_platform",
        publishAt: new Date(Date.now() + 60_000).toISOString(),
        payload: { title: "Scheduled", bodyMarkdown: "Body" },
      });
      expect(claimDuePublishJobs(backendDb, 10)).toEqual([]);
      backendDb.db.update(publishJobs).set({ publishAt: null }).where(eq(publishJobs.jobId, id)).run();
      await runPublishCycle(loadConfig({}), backendDb, testPorts({ test_platform: async () => ({ ok: true, id: "due" }) }));
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "published",
      });
    }));

  it("runs a successful generic publishing cycle", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 101,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const claimed = await runPublishCycle(
        loadConfig({}),
        backendDb,
        testPorts({
          test_platform: async () => ({ ok: true, id: "test-platform-1", url: "https://example.test/posts/test-platform-1" }),
        }),
      );
      expect(claimed).toBe(1);
      const job = backendDb.db
        .select({ status: publishJobs.status, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toEqual({ status: "published", lastError: null });
      const phases = backendDb.db
        .select({ details: postEvents.detailsJson })
        .from(postEvents)
        .where(eq(postEvents.eventType, "publish.job.phase"))
        .all()
        .map((row) => JSON.parse(row.details ?? "{}") as Record<string, unknown>);
      expect(phases.map((phase) => phase.phase)).toEqual(["validate", "prepare", "provider.publish", "provider.verify"]);
      expect(phases.every((phase) => typeof phase.duration_ms === "number")).toBe(true);
      const target = backendDb.db
        .select({
          status: postTargets.status,
          externalId: postTargets.externalId,
          url: postTargets.url,
          publishedAt: postTargets.publishedAt,
        })
        .from(postTargets)
        .where(eq(postTargets.target, "test_platform"))
        .get();
      expect(target).toMatchObject({
        status: "published",
        externalId: "test-platform-1",
        url: "https://example.test/posts/test-platform-1",
      });
      // Analytics scopes and orders published targets by this column.
      expect(target?.publishedAt).toBeString();
    }));

  it("serializes jobs for the same target but never lets one target block another", () =>
    withDb(async (backendDb) => {
      enqueuePublishJob(backendDb, { messageId: 600, target: "slow-target", payload: { title: "Queued" } });
      enqueuePublishJob(backendDb, { messageId: 601, target: "slow-target", payload: { title: "Queued" } });
      enqueuePublishJob(backendDb, { messageId: 602, target: "fast-target", payload: { title: "Queued" } });

      let activeSlow = 0;
      let maxActiveSlow = 0;
      let fastElapsedMs: number | null = null;
      const start = Date.now();
      const publishers = testPorts({
        "slow-target": async () => {
          activeSlow += 1;
          maxActiveSlow = Math.max(maxActiveSlow, activeSlow);
          await Bun.sleep(50);
          activeSlow -= 1;
          return { ok: true, id: "slow" };
        },
        "fast-target": async () => {
          fastElapsedMs = Date.now() - start;
          return { ok: true, id: "fast" };
        },
      });
      await runPublishCycle(loadConfig({}), backendDb, publishers);
      // Two jobs on the same target never overlap...
      expect(maxActiveSlow).toBe(1);
      // ...but a stuck/slow target doesn't hold up an unrelated one.
      expect(fastElapsedMs).not.toBeNull();
      expect(fastElapsedMs as unknown as number).toBeLessThan(50);
    }));

  it("heartbeats a job's lock while a slow publish call is in flight", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, { messageId: 700, target: "slow-target", payload: { title: "Queued" } });
      let lockedAtDuringPublish: string | null | undefined;
      await runPublishCycle(
        loadConfig({ PUBLISH_HEARTBEAT_INTERVAL_SECONDS: "1" }),
        backendDb,
        testPorts({
          "slow-target": async () => {
            await Bun.sleep(1100);
            lockedAtDuringPublish = backendDb.db
              .select({ lockedAt: publishJobs.lockedAt })
              .from(publishJobs)
              .where(eq(publishJobs.jobId, id))
              .get()?.lockedAt;
            return { ok: true, id: "slow" };
          },
        }),
      );
      const claimedAt = backendDb.db.select({ lockedAt: publishJobs.lockedAt }).from(publishJobs).where(eq(publishJobs.jobId, id)).get();
      // The job already completed by the time we read it back, so lockedAt is
      // cleared; what matters is the heartbeat fired at least once mid-publish.
      expect(lockedAtDuringPublish).not.toBeUndefined();
      expect(lockedAtDuringPublish).not.toBeNull();
      expect(claimedAt?.lockedAt).toBeNull();
    }));

  it("retries transient publisher failures", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 102,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      await runPublishCycle(
        loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }),
        backendDb,
        testPorts({
          test_platform: async () => {
            throw new HttpPublishError("temporary", 503, "temporary");
          },
        }),
      );
      const job = backendDb.db
        .select({
          status: publishJobs.status,
          attemptCount: publishJobs.attemptCount,
          nextAttemptAt: publishJobs.nextAttemptAt,
          lastError: publishJobs.lastError,
        })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected retry job");
      expect(job.status).toBe("queued");
      expect(job.attemptCount).toBe(1);
      expect(job.nextAttemptAt).toBeTruthy();
      expect(job.lastError).toContain("temporary");
    }));

  it("requires verification when a provider may have published before transport failed", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 1011,
        target: "ambiguous-provider",
        payload: { title: "Queued" },
      });
      await runPublishCycle(
        loadConfig({}),
        backendDb,
        testPorts({
          "ambiguous-provider": async () => {
            throw new AmbiguousPublicationError("ambiguous-provider", new Error("socket closed"));
          },
        }),
      );
      expect(
        backendDb.db
          .select({ status: publishJobs.status, nextAttemptAt: publishJobs.nextAttemptAt })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "verification_required", nextAttemptAt: null });
      expect(
        backendDb.db.select({ status: postTargets.status }).from(postTargets).where(eq(postTargets.target, "ambiguous-provider")).get(),
      ).toEqual({ status: "verification_required" });
    }));

  it("retries an unknown failure once and then fails it", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 104,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const publishers = testPorts({
        test_platform: async () => {
          throw new Error("unclassified upstream response");
        },
      });
      const config = loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" });
      await runPublishCycle(config, backendDb, publishers);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "queued", attemptCount: 1 });

      backendDb.db.update(publishJobs).set({ nextAttemptAt: null }).where(eq(publishJobs.jobId, id)).run();
      await runPublishCycle(config, backendDb, publishers);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "failed", attemptCount: 2 });
    }));

  it("keeps a whole-job timeout retryable because preparation may not have reached the provider", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 105,
        target: "slow-provider",
        payload: { title: "Queued" },
      });
      await runPublishCycle(
        loadConfig({ PUBLISH_JOB_TIMEOUT_SECONDS: "1" }),
        backendDb,
        testPorts({
          "slow-provider": testAdapter(async () => ({ ok: true }), {
            prepare: async () => await new Promise<never>(() => undefined),
          }),
        }),
      );
      expect(
        backendDb.db
          .select({ status: publishJobs.status, attemptCount: publishJobs.attemptCount, lastError: publishJobs.lastError })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({
        status: "failed",
        attemptCount: 1,
        lastError: "delivery_execution_timeout: slow-provider exceeded 1s during prepare",
      });
    }));

  it("fences delayed preparation from publishing after its worker timed out", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 1051,
        target: "slow-prepare",
        payload: { title: "Queued" },
      });
      let releasePreparation: (() => void) | undefined;
      let publishCalls = 0;
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      await runPublishCycle(
        loadConfig({ PUBLISH_JOB_TIMEOUT_SECONDS: "1" }),
        backendDb,
        testPorts({
          "slow-prepare": testAdapter(
            async () => {
              publishCalls += 1;
              return { ok: true };
            },
            {
              prepare: async (job) => {
                await preparation;
                return job;
              },
            },
          ),
        }),
      );
      releasePreparation?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(publishCalls).toBe(0);
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "failed",
      });
    }));

  it("holds a stale publishing lock for verification instead of risking a duplicate", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 103,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "provider.publish",
          lockedBy: "old-worker",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();
      expect(recoverStalePublishJobs(backendDb, loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }))).toBe(1);
      const job = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toEqual({ status: "verification_required", lockedBy: null });
      expect(
        backendDb.db.select({ status: postTargets.status }).from(postTargets).where(eq(postTargets.target, "test_platform")).get(),
      ).toEqual({
        status: "verification_required",
      });
    }));

  it("requeues a stale preparation lock because no public mutation started", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 1032,
        target: "test_platform",
        payload: { title: "Queued" },
      });
      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "prepare",
          lockedBy: "old-worker",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();

      expect(recoverStalePublishJobs(backendDb, loadConfig({}))).toBe(1);
      expect(
        backendDb.db
          .select({ status: publishJobs.status, currentPhase: publishJobs.currentPhase })
          .from(publishJobs)
          .where(eq(publishJobs.jobId, id))
          .get(),
      ).toEqual({ status: "queued", currentPhase: null });
    }));

  it("keeps stale lock recovery available when the delivery loop is still awaiting a provider", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 1031,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      backendDb.db
        .update(publishJobs)
        .set({
          status: "publishing",
          currentPhase: "provider.publish",
          lockedBy: "hung-provider",
          lockedAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        })
        .where(eq(publishJobs.jobId, id))
        .run();

      expect(runPublishWatchdog(loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }), backendDb)).toBe(1);
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "verification_required",
      });
    }));

  it("does not let a stale worker overwrite a recovered job", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 104,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const [claimed] = claimDuePublishJobs(backendDb, 1, "old-worker");
      if (!claimed) throw new Error("expected claimed job");
      backendDb.db
        .update(publishJobs)
        .set({ currentPhase: "provider.publish", lockedAt: "2000-01-01T00:00:00.000Z" })
        .where(eq(publishJobs.jobId, id))
        .run();
      recoverStalePublishJobs(backendDb, loadConfig({}));

      completePublishJob(backendDb, loadConfig({}), id, { ok: true, id: "late" }, claimed.lockId);

      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "verification_required",
      });
    }));

  it("requeues a retryable result with an external ID as reconciliation, not a new publication", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, { messageId: 106, target: "test_platform", payload: { text_en: "Queued" } });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }), id, {
        ok: false,
        id: "at://did/app.bsky.feed.post/root",
        retryable: true,
        error: "test_visibility_failed:not_in_author_feed",
      });

      const job = backendDb.db
        .select({ status: publishJobs.status, payloadJson: publishJobs.payloadJson })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toMatchObject({ status: "queued", payloadJson: { _reconcile_ids: ["at://did/app.bsky.feed.post/root"] } });
      const target = backendDb.db.select({ status: postTargets.status, externalId: postTargets.externalId }).from(postTargets).get();
      expect(target).toEqual({ status: "queued", externalId: "at://did/app.bsky.feed.post/root" });
    }));

  it("does not leave a job publishing when result finalization fails", () =>
    withDb(async (backendDb) => {
      const id = enqueuePublishJob(backendDb, {
        messageId: 105,
        target: "test_platform",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      await runPublishCycle(
        loadConfig({}),
        backendDb,
        testPorts({
          test_platform: async () => {
            backendDb.sqlite.exec("DROP TABLE post_events; CREATE TABLE post_events (id INTEGER PRIMARY KEY)");
            return { ok: true, id: "test-platform-1" };
          },
        }),
      );
      const job = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected settled job");
      expect(job.status).toBe("verification_required");
      expect(job.lockedBy).toBeNull();
      expect(
        backendDb.db
          .select({ status: postTargets.status, externalId: postTargets.externalId })
          .from(postTargets)
          .where(eq(postTargets.target, "test_platform"))
          .get(),
      ).toEqual({ status: "verification_required", externalId: "test-platform-1" });
      expect(job.lastError).toContain("worker finalization failed");
    }));

  it("does not delete another legacy post while deduplicating a completed target", () =>
    withDb((backendDb) => {
      const first = enqueuePublishJob(backendDb, { messageId: 201, target: "test_platform", payload: { title: "One" } });
      const second = enqueuePublishJob(backendDb, { messageId: 202, target: "test_platform", payload: { title: "Two" } });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, loadConfig({}), first, { ok: true, id: "first" });
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, second)).get()).toEqual({
        status: "queued",
      });
    }));

  it("persists Threads partial state and requeues only the unfinished tail", () =>
    withDb((backendDb) => {
      const id = enqueuePublishJob(backendDb, { messageId: 301, target: "threads_en", payload: { text_en: "One\n\nTwo" } });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, loadConfig({ PUBLISH_BACKOFF_BASE_SECONDS: "1" }), id, {
        partial: true,
        ids: ["root-id"],
        error: "reply container missing",
      });
      const job = backendDb.db
        .select({
          status: publishJobs.status,
          attemptCount: publishJobs.attemptCount,
          payloadJson: publishJobs.payloadJson,
          lastError: publishJobs.lastError,
        })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected partial job");
      expect(job.status).toBe("queued");
      expect(job.attemptCount).toBe(1);
      expect(job.payloadJson).toMatchObject({ _threadsPublishedIds: ["root-id"] });
      expect(job.lastError).toContain("reply container missing");
    }));
});
