import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { targetLocale } from "../src/botTargets.js";
import { type BackendDb, unsafeDb } from "../src/db/client.js";
import { publishJobs, siteJobs } from "../src/db/schema.js";
import type { DeliveryPorts } from "../src/delivery/ports.js";
import { runPublishCycle } from "../src/runtime/workers.js";
import { postService } from "../src/studio/services/posts.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

let backendDb: BackendDb | null = null;

function openPostDb(): BackendDb {
  const memory = ":memory:";
  const db = openBackendDb(memory);
  registerTestChannels(db, TEXT_TEST_CHANNELS);
  return db;
}

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

function enTargetsDueNow(db: BackendDb, postId: number): string[] {
  const now = new Date().toISOString();
  const social = unsafeDb(db)
    .db.select({ target: publishJobs.target, publishAt: publishJobs.publishAt })
    .from(publishJobs)
    .where(eq(publishJobs.publicationId, postId))
    .all()
    .filter((job) => targetLocale(job.target) === "en" && (job.publishAt == null || job.publishAt <= now))
    .map((job) => job.target);
  const site = unsafeDb(db)
    .db.select({ reason: siteJobs.reason, nextAttemptAt: siteJobs.nextAttemptAt })
    .from(siteJobs)
    .where(eq(siteJobs.postId, postId))
    .all()
    .filter((job) => job.reason.includes("en") && (job.nextAttemptAt == null || job.nextAttemptAt <= now))
    .map((job) => job.reason);
  return [...social, ...site];
}

describe("partial locale scheduling", () => {
  it("finishes a RU-only post without waiting for an EN schedule", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });
    expect(posts.cycleMode(42, draftId)).toBe("full");
    expect(posts.cycleMode(42, draftId)).toBe("ru");

    const { ruAt, enAt } = posts.scheduleAt(42, draftId, "ru", new Date(Date.now() + 3_600_000));
    expect(enAt).toBeNull();
    const postId = posts.schedule(42, draftId, { ruAt, enAt });

    expect(
      unsafeDb(backendDb).db.select({ target: publishJobs.target }).from(publishJobs).where(eq(publishJobs.publicationId, postId)).all(),
    ).not.toContainEqual(expect.objectContaining({ target: "threads_en" }));
    expect(posts.hasLocaleTargets(42, draftId, "en")).toBe(false);
  });

  it("finishes an EN-only post without waiting for a RU schedule", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });
    expect(posts.cycleMode(42, draftId)).toBe("full");
    expect(posts.cycleMode(42, draftId)).toBe("ru");
    expect(posts.cycleMode(42, draftId)).toBe("en");

    const { ruAt, enAt } = posts.scheduleAt(42, draftId, "en", new Date(Date.now() + 3_600_000));
    expect(ruAt).toBeNull();
    const postId = posts.schedule(42, draftId, { ruAt, enAt });

    expect(
      unsafeDb(backendDb).db.select({ target: publishJobs.target }).from(publishJobs).where(eq(publishJobs.publicationId, postId)).all(),
    ).not.toContainEqual(expect.objectContaining({ target: "threads_ru" }));
    expect(posts.hasLocaleTargets(42, draftId, "ru")).toBe(false);
  });

  it("does not publish EN while its time has not been chosen yet", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });

    // The editor picks "RU now" and has not reached the EN slot screen yet.
    const { ruAt, enAt } = posts.scheduleAt(42, draftId, "ru", new Date());
    expect(enAt).toBeNull();
    const postId = posts.schedule(42, draftId, { ruAt, enAt, immediateLocale: "ru" });

    expect(enTargetsDueNow(backendDb, postId)).toEqual([]);
  });

  it("queues EN once its time is chosen", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });

    const first = posts.scheduleAt(42, draftId, "ru", new Date());
    const postId = posts.schedule(42, draftId, { ...first, immediateLocale: "ru" });
    const second = posts.scheduleAt(42, draftId, "en", new Date(Date.now() + 3_600_000));
    expect(second.ruAt).not.toBeNull();
    posts.schedule(42, draftId, second);

    const enJobs = unsafeDb(backendDb)
      .db.select({ target: publishJobs.target })
      .from(publishJobs)
      .where(eq(publishJobs.publicationId, postId))
      .all()
      .filter((job) => targetLocale(job.target) === "en");
    expect(enJobs.length).toBeGreaterThan(0);
  });

  it("represents a locale published now without a fake future timestamp", () => {
    backendDb = openPostDb();
    const posts = postService(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });

    const postId = posts.schedule(42, draftId, { ruAt: new Date(), enAt: null, immediateLocale: "ru" });
    const ruJobs = unsafeDb(backendDb)
      .db.select({ target: publishJobs.target, publishAt: publishJobs.publishAt })
      .from(publishJobs)
      .where(eq(publishJobs.publicationId, postId))
      .all()
      .filter((job) => targetLocale(job.target) === "ru");
    expect(ruJobs.length).toBeGreaterThan(0);
    expect(ruJobs.every((job) => job.publishAt != null && new Date(job.publishAt).getTime() <= Date.now())).toBe(true);

    const second = posts.scheduleAt(42, draftId, "en", new Date(Date.now() + 3_600_000));
    posts.schedule(42, draftId, second);
  });

  it("publishes each scheduled locale exactly once when the worker reaches both times", async () => {
    backendDb = openPostDb();
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
    const posts = postService(backendDb, config);
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });
    const base = new Date();
    const postId = posts.schedule(42, draftId, {
      ruAt: new Date(base.getTime() + 25),
      enAt: new Date(base.getTime() + 25),
    });
    const calls: string[] = [];
    const publishers: DeliveryPorts = Object.fromEntries(
      ["telegram", "threads_ru", "threads_en"].map((target) => [
        target,
        {
          publish: async (job) => {
            calls.push(job.target);
            return { ok: true, id: `${job.target}-published` };
          },
          prepare: async (job) => job,
          validate: async () => undefined,
          verify: async (_job, result) => result,
        },
      ]),
    );
    await Bun.sleep(100);
    expect(await runPublishCycle(config, backendDb, publishers)).toBe(3);
    expect(calls).toHaveLength(3);
    expect(new Set(calls)).toEqual(new Set(["telegram", "threads_ru", "threads_en"]));
    expect(
      unsafeDb(backendDb)
        .db.select({ status: publishJobs.status })
        .from(publishJobs)
        .where(eq(publishJobs.publicationId, postId))
        .all()
        .every((job) => job.status === "published"),
    ).toBe(true);

    expect(await runPublishCycle(config, backendDb, publishers)).toBe(0);
    expect(calls).toHaveLength(3);
  });
});
