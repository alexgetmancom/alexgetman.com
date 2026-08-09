import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { drafts, postSources, publicationSources, publishJobs, siteJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { postService } from "../src/studio/services/posts.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: UnsafeBackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("Studio post commands", () => {
  it("previews EN entities and falls back to RU media exactly like delivery", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, {
      text: "Russian text",
      textEn: "English text",
      entities: [],
      media: [{ type: "photo", asset_id: 7 }],
    });
    posts.edit(42, draftId, {
      locale: "en",
      text: "English text",
      entities: [{ type: "bold", offset: 0, length: 7 }],
      media: [],
    });

    const preview = posts.preview(42, draftId);
    expect(preview.locales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ locale: "en", text: "English text", entities: [{ type: "bold", offset: 0, length: 7 }] }),
      ]),
    );
    expect(preview.locales.find((locale) => locale.locale === "en")?.media).toEqual([{ type: "photo", asset_id: 7 }]);
  });

  it("shares draft commands with configured Studio admins and rejects outsiders", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42,7" }));
    const draftId = posts.create(42, { text: "Private draft", textEn: "Private draft", entities: [], media: [] });

    expect(posts.get(7, draftId).id).toBe(draftId);
    posts.toggleTarget(7, draftId, "telegram");
    expect(() => posts.get(9, draftId)).toThrow("err.post-not-yours");
    expect(() => posts.publish(9, draftId)).toThrow("err.post-not-yours");
    expect(() => posts.cancel(9, draftId)).toThrow("err.post-not-yours");

    expect(posts.get(42, draftId).id).toBe(draftId);
    expect(posts.progress(42, draftId).targets.length).toBeGreaterThan(0);
  });

  it("resolves manual schedule plans before publishing them", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Schedule", textEn: "Schedule", entities: [], media: [] });

    const manual = posts.manualSchedule(42, draftId, "both", "23:15");
    expect(manual.ruAt?.getMinutes()).toBe(15);
    expect(manual.enAt?.getMinutes()).toBe(15);
  });

  it("replans unfinished targets when a scheduled post's platforms change", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Targets", textEn: "Targets", entities: [], media: [] });
    posts.toggleTarget(42, draftId, "threads_en");
    const ruAt = new Date(Date.now() + 5 * 60_000);
    const enAt = new Date(Date.now() + 6 * 60_000);
    const postId = posts.schedule(42, draftId, { ruAt, enAt });

    expect(
      backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE post_id=? AND target='threads_en'").get(postId),
    ).toEqual({
      count: 0,
    });

    posts.toggleTarget(42, draftId, "threads_en");
    expect(backendDb.sqlite.prepare("SELECT publish_at FROM publish_jobs WHERE post_id=? AND target='threads_en'").get(postId)).toEqual({
      publish_at: enAt.toISOString(),
    });

    posts.toggleTarget(42, draftId, "threads_en");
    expect(
      backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE post_id=? AND target='threads_en'").get(postId),
    ).toEqual({
      count: 0,
    });
  });

  it("rejects a post schedule that is already in the past", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Past", textEn: "Past", entities: [], media: [] });

    expect(() => posts.schedule(42, draftId, { ruAt: new Date(Date.now() - 1_000), enAt: null })).toThrow("err.schedule-time-past");
  });

  it("replans the durable payload when a scheduled post is edited", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] });

    const source = backendDb.db.select().from(publicationSources).where(eq(publicationSources.postId, postId)).get();
    const job = backendDb.db.select().from(publishJobs).where(eq(publishJobs.postId, postId)).get();
    expect(source?.itemJson).toMatchObject({ text_ru: "After" });
    expect(job?.payloadJson).toMatchObject({ text_ru: "After" });
  });

  it("uses effective targets when deciding whether a Story-card replan must wait", () => {
    backendDb = openBackendDb(":memory:");
    registerChannel(backendDb, {
      platform: "site",
      locale: "ru",
      provider: "internal",
      targetId: "site_ru",
      source: "test",
    });
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    posts.setStoryPublishMode(42, draftId, "all");
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] });

    expect(backendDb.db.select().from(publicationSources).where(eq(publicationSources.postId, postId)).get()?.itemJson).toMatchObject({
      text_ru: "After",
    });
  });

  it("restores an unapproved EN translation as null when a replan rejects the edit", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    expect(() =>
      posts.edit(42, draftId, {
        locale: "en",
        text: "x".repeat(501),
        entities: [],
        media: [],
      }),
    ).toThrow();
    expect(backendDb.db.select({ textEnApproved: drafts.textEnApproved }).from(drafts).where(eq(drafts.id, draftId)).get()).toEqual({
      textEnApproved: null,
    });
  });

  it("blocks material edits inside the publication lock window", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Before", textEn: "Before", entities: [], media: [] });
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60_000), enAt: null });

    expect(() => posts.edit(42, draftId, { locale: "ru", text: "After", entities: [], media: [] })).toThrow(
      "err.post-too-close-to-publish",
    );
    expect(() => posts.toggleTarget(42, draftId, "telegram")).toThrow("err.post-too-close-to-publish");
  });

  it("replaces copied publication sources when a scheduled draft changes them", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Sources", textEn: "Sources", entities: [], media: [] });
    posts.replaceSources(42, draftId, ["https://before.example"]);
    const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 5 * 60_000), enAt: null });

    posts.replaceSources(42, draftId, ["https://after.example"]);

    expect(backendDb.db.select({ url: postSources.url }).from(postSources).where(eq(postSources.postId, postId)).all()).toEqual([
      { url: "https://after.example" },
    ]);
  });

  it("blocks content mutations after the publication is settled but allows rescheduling", () => {
    backendDb = openBackendDb(":memory:");
    const posts = postService(backendDb, loadConfig({ ADMIN_IDS: "42" }));
    const draftId = posts.create(42, { text: "Settled", textEn: "Settled", entities: [], media: [] });
    backendDb.db.update(drafts).set({ status: "published" }).where(eq(drafts.id, draftId)).run();

    expect(() => posts.edit(42, draftId, { locale: "ru", text: "Changed", entities: [], media: [] })).toThrow("err.post-locked");
    expect(() => posts.toggleTarget(42, draftId, "telegram")).toThrow("err.post-locked");
    expect(() => posts.publish(42, draftId)).toThrow("err.post-locked");
    expect(() => posts.cancel(42, draftId)).toThrow("err.post-locked");
    posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60_000), enAt: null });
  });

  it("does not duplicate final jobs when a settled post is rescheduled", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ ADMIN_IDS: "42" });
    const posts = postService(backendDb, config);
    const draftId = posts.create(42, { text: "Settled", textEn: "Settled", entities: [], media: [] });
    const firstAt = new Date(Date.now() + 5 * 60_000);
    const postId = posts.schedule(42, draftId, { ruAt: firstAt, enAt: firstAt });
    const socialBefore = backendDb.db.select({ jobId: publishJobs.jobId }).from(publishJobs).where(eq(publishJobs.postId, postId)).all();
    const siteBefore = backendDb.db.select({ jobId: siteJobs.jobId }).from(siteJobs).where(eq(siteJobs.postId, postId)).all();

    backendDb.db.update(publishJobs).set({ status: "published" }).where(eq(publishJobs.postId, postId)).run();
    backendDb.db.update(siteJobs).set({ status: "published" }).where(eq(siteJobs.postId, postId)).run();
    backendDb.db.update(drafts).set({ status: "published" }).where(eq(drafts.id, draftId)).run();

    const nextAt = new Date(Date.now() + 10 * 60_000);
    posts.schedule(42, draftId, { ruAt: nextAt, enAt: nextAt });
    expect(backendDb.db.select({ jobId: publishJobs.jobId }).from(publishJobs).where(eq(publishJobs.postId, postId)).all()).toEqual(
      socialBefore,
    );
    expect(backendDb.db.select({ jobId: siteJobs.jobId }).from(siteJobs).where(eq(siteJobs.postId, postId)).all()).toEqual(siteBefore);
    expect(
      backendDb.db
        .select({ status: publishJobs.status })
        .from(publishJobs)
        .where(eq(publishJobs.postId, postId))
        .all()
        .every((job) => job.status === "published"),
    ).toBe(true);
    expect(posts.get(42, draftId)).toMatchObject({
      status: "published",
      scheduled_at: nextAt.toISOString(),
      scheduled_en_at: nextAt.toISOString(),
    });
  });
});
