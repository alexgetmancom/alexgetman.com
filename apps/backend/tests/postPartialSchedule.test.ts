import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { targetLocale } from "../src/botTargets.js";
import { type BackendDb, unsafeDb } from "../src/db/client.js";
import { publishJobs, siteJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { scheduleNow } from "../src/publishing/schedule.js";
import { postService } from "../src/studio/services/posts.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

function enTargetsDueNow(db: BackendDb, postId: number): string[] {
  const now = new Date().toISOString();
  const social = unsafeDb(db)
    .db.select({ target: publishJobs.target, publishAt: publishJobs.publishAt })
    .from(publishJobs)
    .where(eq(publishJobs.postId, postId))
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
  it("does not publish EN while its time has not been chosen yet", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });

    // The editor picks "RU now" and has not reached the EN slot screen yet.
    const { ruAt, enAt } = posts.scheduleAt(42, draftId, "ru", scheduleNow());
    expect(enAt).toBeNull();
    const postId = posts.schedule(42, draftId, { ruAt, enAt });

    expect(enTargetsDueNow(backendDb, postId)).toEqual([]);
  });

  it("queues EN once its time is chosen", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });

    const first = posts.scheduleAt(42, draftId, "ru", scheduleNow());
    const postId = posts.schedule(42, draftId, first);
    const second = posts.scheduleAt(42, draftId, "en", new Date(Date.now() + 3_600_000));
    expect(second.ruAt).not.toBeNull();
    posts.schedule(42, draftId, second);

    const enJobs = unsafeDb(backendDb)
      .db.select({ target: publishJobs.target })
      .from(publishJobs)
      .where(eq(publishJobs.postId, postId))
      .all()
      .filter((job) => targetLocale(job.target) === "en");
    expect(enJobs.length).toBeGreaterThan(0);
  });

  it("represents a locale published now without a fake future timestamp", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Russian", textEn: "English", entities: [], media: [] });

    const postId = posts.schedule(42, draftId, { ruAt: new Date(), enAt: null, immediateLocale: "ru" });
    const ruJobs = unsafeDb(backendDb)
      .db.select({ target: publishJobs.target, publishAt: publishJobs.publishAt })
      .from(publishJobs)
      .where(eq(publishJobs.postId, postId))
      .all()
      .filter((job) => targetLocale(job.target) === "ru");
    expect(ruJobs.length).toBeGreaterThan(0);
    expect(ruJobs.every((job) => job.publishAt != null && new Date(job.publishAt).getTime() <= Date.now())).toBe(true);

    const second = posts.scheduleAt(42, draftId, "en", new Date(Date.now() + 3_600_000));
    expect(() => posts.schedule(42, draftId, second)).not.toThrow();
  });
});
