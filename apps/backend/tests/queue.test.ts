import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
import { postTargets, publishJobs } from "../src/db/schema.js";
import { HttpPublishError } from "../src/queue/errors.js";
import { claimDuePublishJobs, completePublishJob, enqueuePublishJob, recoverStalePublishJobs } from "../src/queue/publish.js";
import { runPublishCycle } from "../src/worker.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-queue-"));
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

describe("publish queue", () => {
  it("claims queued publish jobs and marks target publishing", () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 100,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const [job] = claimDuePublishJobs(backendDb, 10, "test-worker");
      expect(job).toMatchObject({ jobId: id, messageId: 100, target: "devto" });
      const row = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(row).toEqual({ status: "publishing", lockedBy: "test-worker" });
      const target = backendDb.db.select({ status: postTargets.status }).from(postTargets).where(eq(postTargets.target, "devto")).get();
      if (!target) throw new Error("expected post target");
      expect(target.status).toBe("publishing");
    } finally {
      backendDb.close();
    }
  });

  it("does not claim a scheduled job before its publish time and executes it when due", async () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 99,
        target: "devto",
        publishAt: new Date(Date.now() + 60_000).toISOString(),
        payload: { title: "Scheduled", bodyMarkdown: "Body" },
      });
      expect(claimDuePublishJobs(backendDb, 10)).toEqual([]);
      backendDb.db.update(publishJobs).set({ publishAt: null }).where(eq(publishJobs.jobId, id)).run();
      await runPublishCycle(loadConfig({ DEVTO_API_KEY: "secret" }), backendDb, { devto: async () => ({ ok: true, id: "due" }) });
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, id)).get()).toEqual({
        status: "published",
      });
    } finally {
      backendDb.close();
    }
  });

  it("runs a successful Dev.to publishing cycle", async () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 101,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const claimed = await runPublishCycle(loadConfig({ DEVTO_API_KEY: "secret" }), backendDb, {
        devto: async () => ({ ok: true, id: "devto-1", url: "https://dev.to/a/devto-1" }),
      });
      expect(claimed).toBe(1);
      const job = backendDb.db
        .select({ status: publishJobs.status, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toEqual({ status: "published", lastError: null });
      const target = backendDb.db
        .select({ status: postTargets.status, externalId: postTargets.externalId, url: postTargets.url })
        .from(postTargets)
        .where(eq(postTargets.target, "devto"))
        .get();
      expect(target).toEqual({ status: "published", externalId: "devto-1", url: "https://dev.to/a/devto-1" });
    } finally {
      backendDb.close();
    }
  });

  it("bounds concurrent target publishing", async () => {
    const backendDb = tempDb();
    try {
      for (let index = 0; index < 5; index += 1)
        enqueuePublishJob(backendDb, { messageId: 600 + index, target: `target-${index}`, payload: { title: "Queued" } });
      let active = 0;
      let maximum = 0;
      const publishers = Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `target-${index}`,
          async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await Bun.sleep(10);
            active -= 1;
            return { ok: true, id: String(index) };
          },
        ]),
      );
      await runPublishCycle(loadConfig({ PUBLISH_MAX_CONCURRENCY: "2" }), backendDb, publishers);
      expect(maximum).toBe(2);
    } finally {
      backendDb.close();
    }
  });

  it("retries transient publisher failures", async () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 102,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      await runPublishCycle(loadConfig({ DEVTO_API_KEY: "secret", PUBLISH_BACKOFF_BASE_SECONDS: "1" }), backendDb, {
        devto: async () => {
          throw new HttpPublishError("temporary", 503, "temporary");
        },
      });
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
    } finally {
      backendDb.close();
    }
  });

  it("retries an unknown failure once and then fails it", async () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 104,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      const publishers = {
        devto: async () => {
          throw new Error("unclassified upstream response");
        },
      };
      const config = loadConfig({ DEVTO_API_KEY: "secret", PUBLISH_BACKOFF_BASE_SECONDS: "1" });
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
    } finally {
      backendDb.close();
    }
  });

  it("fails stale publishing locks without automatically repeating an external publication", () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 103,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      backendDb.db
        .update(publishJobs)
        .set({ status: "publishing", lockedBy: "old-worker", lockedAt: "2000-01-01T00:00:00.000Z", updatedAt: "2000-01-01T00:00:00.000Z" })
        .where(eq(publishJobs.jobId, id))
        .run();
      expect(recoverStalePublishJobs(backendDb, 1)).toBe(1);
      const job = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      expect(job).toEqual({ status: "failed", lockedBy: null });
    } finally {
      backendDb.close();
    }
  });

  it("does not leave a job publishing when result finalization fails", async () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 105,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      await runPublishCycle(loadConfig({ DEVTO_API_KEY: "secret" }), backendDb, {
        devto: async () => {
          backendDb.sqlite.exec("DROP TABLE post_events; CREATE TABLE post_events (id INTEGER PRIMARY KEY)");
          return { ok: true, id: "devto-1" };
        },
      });
      const job = backendDb.db
        .select({ status: publishJobs.status, lockedBy: publishJobs.lockedBy, lastError: publishJobs.lastError })
        .from(publishJobs)
        .where(eq(publishJobs.jobId, id))
        .get();
      if (!job) throw new Error("expected failed job");
      expect(job.status).toBe("failed");
      expect(job.lockedBy).toBeNull();
      expect(job.lastError).toContain("worker finalization failed");
    } finally {
      backendDb.close();
    }
  });

  it("does not delete another legacy post while deduplicating a completed target", () => {
    const backendDb = tempDb();
    try {
      const first = enqueuePublishJob(backendDb, { messageId: 201, target: "devto", payload: { title: "One" } });
      const second = enqueuePublishJob(backendDb, { messageId: 202, target: "devto", payload: { title: "Two" } });
      claimDuePublishJobs(backendDb, 1, "test-worker");
      completePublishJob(backendDb, loadConfig({}), first, { ok: true, id: "first" });
      expect(backendDb.db.select({ status: publishJobs.status }).from(publishJobs).where(eq(publishJobs.jobId, second)).get()).toEqual({
        status: "queued",
      });
    } finally {
      backendDb.close();
    }
  });

  it("persists Threads partial state and requeues only the unfinished tail", () => {
    const backendDb = tempDb();
    try {
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
    } finally {
      backendDb.close();
    }
  });
});
