import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openBackendDb } from "../src/db/client.js";
import { credentialChecks, type JsonObject } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { isTargetAuthBlocked, recordAuthFailure, recordAuthSuccess } from "../src/observability/auth-circuit.js";
import { HttpPublishError } from "../src/publishing/errors.js";
import { claimDuePublishJobs, enqueuePublishJobTx, failPublishJob } from "../src/publishing/queue.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-auth-circuit-"));
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

describe("auth circuit breaker", () => {
  it("stays closed below the failure threshold", () => {
    const backendDb = tempDb();
    try {
      recordAuthFailure(backendDb, "bluesky");
      recordAuthFailure(backendDb, "bluesky");
      expect(isTargetAuthBlocked(backendDb, "bluesky")).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("trips after consecutive auth failures and clears on success", () => {
    const backendDb = tempDb();
    try {
      recordAuthFailure(backendDb, "bluesky");
      recordAuthFailure(backendDb, "bluesky");
      recordAuthFailure(backendDb, "bluesky");
      expect(isTargetAuthBlocked(backendDb, "bluesky")).toBe(true);

      recordAuthSuccess(backendDb, "bluesky");
      expect(isTargetAuthBlocked(backendDb, "bluesky")).toBe(false);

      const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "bluesky")).get();
      expect(JSON.parse(row?.detailsJson ?? "{}")).toEqual({ authFailureStreak: 0, blockedUntil: null });
    } finally {
      backendDb.close();
    }
  });

  it("does not block a different target", () => {
    const backendDb = tempDb();
    try {
      recordAuthFailure(backendDb, "bluesky");
      recordAuthFailure(backendDb, "bluesky");
      recordAuthFailure(backendDb, "bluesky");
      expect(isTargetAuthBlocked(backendDb, "bluesky")).toBe(true);
      expect(isTargetAuthBlocked(backendDb, "mastodon")).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("failPublishJob records an auth failure for a 401/403 HttpPublishError", () => {
    const backendDb = tempDb();
    try {
      const enqueue = (messageId: number) =>
        enqueuePublishJobTx(backendDb.db, {
          messageId,
          postId: messageId,
          postKey: `post:${messageId}`,
          target: "mastodon",
          payload: { text: "hi" } as JsonObject,
        });

      for (let i = 0; i < 3; i++) {
        const id = enqueue(i);
        const [claimed] = claimDuePublishJobs(backendDb, 1);
        if (!claimed) throw new Error("job was not claimed");
        failPublishJob(backendDb, loadConfig({}), id, new HttpPublishError("unauthorized", 401), claimed.lockId);
      }

      expect(isTargetAuthBlocked(backendDb, "mastodon")).toBe(true);
    } finally {
      backendDb.close();
    }
  });
});
