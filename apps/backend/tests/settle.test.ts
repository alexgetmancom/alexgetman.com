import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publishJobs } from "../src/db/schema.js";
import { type OperationContext, runOperation } from "../src/operations/registry.js";
import { recoverStalePublishJobs } from "../src/publishing/queue.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

let backendDb: UnsafeBackendDb | null = null;
afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const config = loadTestConfig(
  {
    CONTROLLER_ADMIN_IDS: "42",
    MCP_STUDIO_TOKEN: "a".repeat(16),
    MCP_STUDIO_ACTOR_ID: "42",
    THREADS_RU_ACCESS_TOKEN: "t".repeat(20),
    THREADS_RU_USER_ID: "1",
  },
  SITE_STUDIO_PROFILE,
);

function context(db: UnsafeBackendDb): OperationContext {
  return { dbPath: ":memory:", config: () => config, db: () => db, fetchImpl: fetch, actorType: "test" };
}

/** A worker lost between calling the platform and recording the answer: the
 * post may be live and nothing knows its id. Reconciliation asks the platform
 * about a stored id, so it has nothing to ask; `retry` refuses the state on
 * purpose. Without `settle` the only way out was manual SQL. */
async function ambiguousPublication(db: UnsafeBackendDb): Promise<string> {
  await runOperation("channel-connect", context(db), { target: "threads_ru", provider: "native" });
  const published = (await runOperation("publish", context(db), {
    locale: "ru",
    targets: "threads_ru",
    text: "Сегодня разобрал, как мы используем React и Bun в проде",
  })) as { ref: string };
  db.db
    .update(publishJobs)
    .set({ status: "publishing", currentPhase: "provider.verify", lockedBy: "dead", lockedAt: "2000-01-01T00:00:00.000Z" })
    .where(eq(publishJobs.target, "threads_ru"))
    .run();
  recoverStalePublishJobs(db);
  return published.ref;
}

describe("settle", () => {
  it("records the post an operator found, and rolls the publication up with it", async () => {
    backendDb = openBackendDb(":memory:");
    const ref = await ambiguousPublication(backendDb);

    expect(
      ((await runOperation("retry", context(backendDb), { ref, target: "threads_ru", apply: true })) as { results: unknown[] }).results,
    ).toEqual([{ target: "threads_ru", outcome: "not_retryable", status: "verification_required" }]);

    const plan = await runOperation("settle", context(backendDb), { ref, target: "threads_ru", external_id: "18049" });
    expect(plan).toMatchObject({ applied: false, outcome: "published", hint: "re-run with apply to record it" });
    expect(backendDb.sqlite.prepare("SELECT status FROM publication_targets").get()).toEqual({ status: "verification_required" });

    await runOperation("settle", context(backendDb), {
      ref,
      target: "threads_ru",
      external_id: "18049",
      url: "https://threads.net/p/18049",
      apply: true,
    });

    expect(backendDb.sqlite.prepare("SELECT status, external_id, url, confirmation_source FROM publication_targets").get()).toEqual({
      status: "published",
      external_id: "18049",
      url: "https://threads.net/p/18049",
      confirmation_source: "operator",
    });
    expect(backendDb.sqlite.prepare("SELECT status FROM publications").get()).toEqual({ status: "published" });
  });

  it("queues the target again when the operator reports the post absent", async () => {
    backendDb = openBackendDb(":memory:");
    const ref = await ambiguousPublication(backendDb);

    await runOperation("settle", context(backendDb), { ref, target: "threads_ru", apply: true });

    expect(backendDb.sqlite.prepare("SELECT status, external_id FROM publication_targets").get()).toEqual({
      status: "queued",
      external_id: null,
    });
    expect(backendDb.sqlite.prepare("SELECT status, attempt_count FROM publish_jobs").get()).toEqual({
      status: "queued",
      attempt_count: 0,
    });
  });

  it("refuses a target that is not ambiguous", async () => {
    backendDb = openBackendDb(":memory:");
    await runOperation("channel-connect", context(backendDb), { target: "threads_ru", provider: "native" });
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Сегодня разобрал, как мы используем React и Bun в проде",
    })) as { ref: string };

    await expect(
      runOperation("settle", context(backendDb), { ref: published.ref, target: "threads_ru", external_id: "1", apply: true }),
    ).rejects.toThrow("is queued, not verification_required");
    await expect(runOperation("settle", context(backendDb), { ref: published.ref, target: "x", apply: true })).rejects.toThrow(
      "has no publish job",
    );
  });
});
