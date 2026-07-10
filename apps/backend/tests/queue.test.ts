import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { openBackendDb } from "../src/db/client.js";
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
      const row = backendDb.sqlite.prepare("SELECT status, locked_by FROM publish_jobs WHERE job_id=?").get(id) as { status: string; locked_by: string };
      expect(row).toEqual({ status: "publishing", locked_by: "test-worker" });
      const target = backendDb.sqlite.prepare("SELECT status FROM post_targets WHERE target='devto'").get() as { status: string };
      expect(target.status).toBe("publishing");
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
      const job = backendDb.sqlite.prepare("SELECT status, last_error FROM publish_jobs WHERE job_id=?").get(id) as { status: string; last_error: string | null };
      expect(job).toEqual({ status: "published", last_error: null });
      const target = backendDb.sqlite.prepare("SELECT status, external_id, url FROM post_targets WHERE target='devto'").get() as { status: string; external_id: string; url: string };
      expect(target).toEqual({ status: "published", external_id: "devto-1", url: "https://dev.to/a/devto-1" });
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
      const job = backendDb.sqlite.prepare("SELECT status, attempt_count, next_attempt_at, last_error FROM publish_jobs WHERE job_id=?").get(id) as {
        status: string;
        attempt_count: number;
        next_attempt_at: string | null;
        last_error: string;
      };
      expect(job.status).toBe("queued");
      expect(job.attempt_count).toBe(1);
      expect(job.next_attempt_at).toBeTruthy();
      expect(job.last_error).toContain("temporary");
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
      const publishers = { devto: async () => { throw new Error("unclassified upstream response"); } };
      const config = loadConfig({ DEVTO_API_KEY: "secret", PUBLISH_BACKOFF_BASE_SECONDS: "1" });
      await runPublishCycle(config, backendDb, publishers);
      expect((backendDb.sqlite.prepare("SELECT status, attempt_count FROM publish_jobs WHERE job_id=?").get(id) as { status: string; attempt_count: number })).toEqual({ status: "queued", attempt_count: 1 });

      backendDb.sqlite.prepare("UPDATE publish_jobs SET next_attempt_at=NULL WHERE job_id=?").run(id);
      await runPublishCycle(config, backendDb, publishers);
      expect((backendDb.sqlite.prepare("SELECT status, attempt_count FROM publish_jobs WHERE job_id=?").get(id) as { status: string; attempt_count: number })).toEqual({ status: "failed", attempt_count: 2 });
    } finally {
      backendDb.close();
    }
  });

  it("recovers stale publishing locks", () => {
    const backendDb = tempDb();
    try {
      const id = enqueuePublishJob(backendDb, {
        messageId: 103,
        target: "devto",
        payload: { title: "Queued", bodyMarkdown: "Body" },
      });
      backendDb.sqlite
        .prepare("UPDATE publish_jobs SET status='publishing', locked_by='old-worker', locked_at=?, updated_at=? WHERE job_id=?")
        .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", id);
      expect(recoverStalePublishJobs(backendDb, 1)).toBe(1);
      const job = backendDb.sqlite.prepare("SELECT status, locked_by FROM publish_jobs WHERE job_id=?").get(id) as { status: string; locked_by: string | null };
      expect(job).toEqual({ status: "queued", locked_by: null });
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
      const job = backendDb.sqlite.prepare("SELECT status, locked_by, last_error FROM publish_jobs WHERE job_id=?").get(id) as {
        status: string;
        locked_by: string | null;
        last_error: string;
      };
      expect(job.status).toBe("failed");
      expect(job.locked_by).toBeNull();
      expect(job.last_error).toContain("worker finalization failed");
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
      completePublishJob(backendDb, first, { ok: true, id: "first" });
      expect(backendDb.sqlite.prepare("SELECT status FROM publish_jobs WHERE job_id=?").get(second)).toEqual({ status: "queued" });
    } finally {
      backendDb.close();
    }
  });
});
