import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Bot } from "grammy";
import { finalizePendingAlbums } from "../src/bot/albums.js";
import { getPostAdminState, setPostAdminState } from "../src/bot/post-state.js";
import { draftPreview } from "../src/bot/preview.js";
import { postProgress } from "../src/bot/progress.js";
import { DEFAULT_TARGETS, TARGETS, targetLocale } from "../src/botTargets.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { entitiesToHtml } from "../src/content/text.js";
import { type BackendDb, openBackendDb } from "../src/db/client.js";
import { botUiSettings } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { cancelDraft, scheduledDrafts } from "../src/publishing/draft-lifecycle.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { reconcilePublication } from "../src/publishing/queue.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("Telegram controller flow", () => {
  it("keeps mode and manual target controls on one ordinary-publication card", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Card", textEn: "Card", entities: [], media: [] });
    const preview = draftPreview(backendDb, draftId, loadConfig({}));
    expect(preview.text).toContain("Mode: *Manual*");
    expect(JSON.stringify(preview.keyboard)).toContain(`cycle_mode:${draftId}`);
    expect(JSON.stringify(preview.keyboard)).toContain(`platforms:${draftId}`);
    expect(JSON.stringify(preview.keyboard)).not.toContain("use_ru_media");
  });

  it("renders post preview and confirmation controls in the selected interface language", () => {
    backendDb = openBackendDb(":memory:");
    backendDb.db.insert(botUiSettings).values({ adminId: 42, locale: "ru", updatedAt: new Date().toISOString() }).run();
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Карточка", textEn: "Card", entities: [], media: [] });
    const preview = draftPreview(backendDb, draftId, loadConfig({}));

    expect(preview.text).toContain("Режим: *Ручной*");
    expect(JSON.stringify(preview.keyboard)).toContain("Опубликовать");
    expect(JSON.stringify(preview.keyboard)).toContain("Запланировать");
  });

  it("creates a draft and queues enabled publication targets without Telegram API", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Привет\n\nТестовая публикация",
      entities: [],
      media: [{ type: "photo", file_id: "telegram-photo-id", width: 1280, height: 720 }],
    });

    const postId = publishDraftToQueue(backendDb, draftId);
    const draft = backendDb.sqlite.prepare("SELECT status, post_id FROM drafts WHERE id=?").get(draftId) as Record<string, unknown>;
    const jobs = backendDb.sqlite.prepare("SELECT target, status FROM publish_jobs ORDER BY target").all() as Record<string, unknown>[];
    const siteJobs = backendDb.sqlite.prepare("SELECT status, reason FROM site_jobs WHERE post_id=?").all(postId) as Record<
      string,
      unknown
    >[];
    const locales = backendDb.sqlite
      .prepare("SELECT locale, site_enabled FROM post_locales WHERE post_id=? ORDER BY locale")
      .all(postId) as Record<string, unknown>[];

    expect(draft).toMatchObject({ status: "scheduled", post_id: postId });
    expect(jobs.map((job) => job.target)).toEqual([
      "bluesky",
      "devto",
      "facebook",
      "facebook_ru",
      "github_en",
      "github_ru",
      "instagram_stories",
      "instagram_stories_ru",
      "mastodon",
      "telegram",
      "telegram_stories",
      "threads_en",
      "threads_ru",
    ]);
    expect(jobs.every((job) => job.status === "queued")).toBe(true);
    expect(siteJobs).toEqual([
      { status: "queued", reason: "publish_ru" },
      { status: "queued", reason: "publish_en" },
    ]);
    expect(locales).toEqual([
      { locale: "en", site_enabled: 1 },
      { locale: "ru", site_enabled: 1 },
    ]);
  });

  it("stores independent RU and EN publish times for a scheduled draft", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Schedule", textEn: "Schedule", entities: [], media: [] });
    const ruAt = new Date("2026-07-11T07:37:00.000Z");
    const enAt = new Date("2026-07-11T03:37:00.000Z");
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });

    expect(backendDb.sqlite.prepare("SELECT status, scheduled_at, scheduled_en_at FROM drafts WHERE id=?").get(draftId)).toEqual({
      status: "scheduled",
      scheduled_at: ruAt.toISOString(),
      scheduled_en_at: enAt.toISOString(),
    });
    const jobs = backendDb.sqlite.prepare("SELECT target, publish_at FROM publish_jobs WHERE post_id=?").all(postId) as Array<{
      target: string;
      publish_at: string;
    }>;
    expect(jobs.find((job) => job.target === "telegram")?.publish_at).toBe(ruAt.toISOString());
    expect(jobs.find((job) => job.target === "facebook")?.publish_at).toBe(enAt.toISOString());
    expect(backendDb.sqlite.prepare("SELECT reason, next_attempt_at FROM site_jobs WHERE post_id=? ORDER BY reason").all(postId)).toEqual([
      { reason: "publish_en", next_attempt_at: enAt.toISOString() },
      { reason: "publish_ru", next_attempt_at: ruAt.toISOString() },
    ]);
    expect(scheduledDrafts(backendDb)).toEqual([{ id: draftId, scheduledAt: ruAt.toISOString(), scheduledEnAt: enAt.toISOString() }]);
  });

  it("does not enqueue a duplicate target job after that target is already final", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Repeat", textEn: "Repeat", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=? AND target='threads_en'").run(postId);

    publishDraftToQueue(backendDb, draftId);

    expect(
      backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE post_id=? AND target='threads_en'").get(postId),
    ).toEqual({ count: 1 });
  });

  it("marks a publication published only after every social and site job is final", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Complete", textEn: "Complete", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    expect(backendDb.sqlite.prepare("SELECT status FROM publications WHERE post_id=?").get(postId)).toEqual({ status: "scheduled" });

    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE post_id=?").run(postId);
    reconcilePublication(backendDb, postId);

    expect(backendDb.sqlite.prepare("SELECT status FROM publications WHERE post_id=?").get(postId)).toEqual({ status: "published" });
    expect(backendDb.sqlite.prepare("SELECT status FROM drafts WHERE id=?").get(draftId)).toEqual({ status: "published" });
  });

  it("marks a publication failed when one final target fails and preserves cancellation", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Failure", textEn: "Failure", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='failed' WHERE post_id=? AND target='bluesky'").run(postId);
    backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE post_id=?").run(postId);
    reconcilePublication(backendDb, postId);
    expect(backendDb.sqlite.prepare("SELECT status FROM publications WHERE post_id=?").get(postId)).toEqual({ status: "failed" });

    cancelDraft(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=?").run(postId);
    reconcilePublication(backendDb, postId);
    expect(backendDb.sqlite.prepare("SELECT status FROM publications WHERE post_id=?").get(postId)).toEqual({ status: "cancelled" });
  });

  it("removes all unpublished draft artifacts while retaining published history", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Cancel", textEn: "Cancel", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId, {
      mode: "scheduled",
      ruAt: new Date(Date.now() + 60_000),
      enAt: new Date(Date.now() + 60_000),
    });
    cancelDraft(backendDb, draftId);
    expect(backendDb.sqlite.prepare("SELECT post_id FROM drafts WHERE id=?").get(draftId)).toEqual({ post_id: null });
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publications WHERE post_id=?").get(postId)).toEqual({ count: 0 });
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE post_id=?").get(postId)).toEqual({ count: 0 });
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM post_locales WHERE post_id=?").get(postId)).toEqual({ count: 0 });
  });

  it("queues locale-specific text and media for RU and EN targets", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Русский текст",
      textEn: "English text",
      entities: [],
      media: [{ type: "photo", file_id: "ru-image" }],
    });
    backendDb.sqlite
      .prepare("UPDATE drafts SET text_en_approved=?, media_en_json=? WHERE id=?")
      .run("Edited English text", JSON.stringify([{ type: "photo", file_id: "en-image" }]), draftId);
    publishDraftToQueue(backendDb, draftId);

    const jobs = backendDb.sqlite
      .prepare(
        "SELECT target,payload_json FROM publish_jobs WHERE target IN ('telegram','threads_ru','facebook','github_en') ORDER BY target",
      )
      .all() as Array<{ target: string; payload_json: string }>;
    const payloads = Object.fromEntries(jobs.map((job) => [job.target, JSON.parse(job.payload_json) as Record<string, unknown>]));
    for (const target of ["telegram", "threads_ru"]) {
      expect(payloads[target]).toMatchObject({
        locale: "ru",
        text: "Русский текст",
        text_en: "",
        bodyMarkdown: "Русский текст",
        media: [{ type: "IMAGE", fileId: "ru-image" }],
      });
      expect(payloads[target]).not.toHaveProperty("media_en");
    }
    for (const target of ["facebook", "github_en"]) {
      expect(payloads[target]).toMatchObject({
        locale: "en",
        text: "Edited English text",
        text_en: "Edited English text",
        bodyMarkdown: "Edited English text",
        media: [{ type: "IMAGE", fileId: "en-image" }],
        media_en: [{ type: "IMAGE", fileId: "en-image" }],
      });
    }
  });

  it("localizes every enabled social target from its declared locale", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Русский текст",
      textEn: "English text",
      entities: [],
      media: [{ type: "photo", file_id: "ru-image" }],
    });
    backendDb.sqlite
      .prepare("UPDATE drafts SET media_en_json=? WHERE id=?")
      .run(JSON.stringify([{ type: "photo", file_id: "en-image" }]), draftId);
    const postId = publishDraftToQueue(backendDb, draftId);
    const jobs = backendDb.sqlite.prepare("SELECT target,payload_json FROM publish_jobs WHERE post_id=?").all(postId) as Array<{
      target: string;
      payload_json: string;
    }>;
    for (const job of jobs) {
      const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
      const locale = targetLocale(job.target);
      expect(payload.locale).toBe(locale);
      expect(payload.text).toBe(locale === "ru" ? "Русский текст" : "English text");
      expect(payload.media).toEqual([{ type: "IMAGE", fileId: locale === "ru" ? "ru-image" : "en-image" }]);
    }
    expect(jobs).toHaveLength(TARGETS.filter(([id, , , kind]) => kind !== "site" && DEFAULT_TARGETS[id]).length);
  });

  it("preserves Telegram entities in target payloads and site HTML", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Жирный и ссылка",
      textEn: "Bold and link",
      entities: [{ type: "bold", offset: 0, length: 6 }],
      media: [],
    });
    publishDraftToQueue(backendDb, draftId);
    const payload = JSON.parse(
      (backendDb.sqlite.prepare("SELECT payload_json FROM publish_jobs WHERE target='telegram'").get() as { payload_json: string })
        .payload_json,
    ) as Record<string, unknown>;
    expect(payload.entities).toEqual([{ type: "bold", offset: 0, length: 6 }]);
    expect(backendDb.sqlite.prepare("SELECT html FROM post_locales WHERE locale='ru'").get()).toEqual({
      html: "<strong>Жирный</strong> и ссылка",
    });
  });

  it("renders a live post progress card from publication job states", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Progress", textEn: "Progress", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=? AND target='telegram'").run(postId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='publishing' WHERE post_id=? AND target='facebook'").run(postId);
    backendDb.sqlite
      .prepare("UPDATE publish_jobs SET status='failed', last_error='rate limit' WHERE post_id=? AND target='bluesky'")
      .run(postId);

    const progress = postProgress(backendDb, draftId, true);
    expect(progress.text).toContain("Progress: *2 / 15*");
    expect(progress.text).toContain("✅ Published: 1");
    expect(progress.text).toContain("🔄 Publishing: 1");
    expect(progress.text).toContain("❌ Failed: 1");
    expect(progress.text).toContain("❌ Bluesky — rate limit");
    expect(JSON.stringify(progress.keyboard)).toContain(`progress:${draftId}`);
  });

  it("finalizes a durable Telegram media album into one draft", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,admin_id,chat_id,media_group_id,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('album',42,42,'group','Album caption','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(
        JSON.stringify([
          { type: "photo", file_id: "one" },
          { type: "photo", file_id: "two" },
        ]),
      );
    const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const fakeBot = { api: { sendMessage } } as unknown as Bot;

    expect(await finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" }))).toBe(1);
    const draft = backendDb.sqlite.prepare("SELECT text_ru, media_ru_json FROM drafts").get() as { text_ru: string; media_ru_json: string };
    expect(draft.text_ru).toBe("Album caption");
    expect(JSON.parse(draft.media_ru_json)).toHaveLength(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_albums").get() as { count: number }).count).toBe(0);
  });

  it("applies an English edit album to its draft instead of creating a new draft", async () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Русский исходник",
      textEn: "English source",
      entities: [],
      media: [{ type: "photo", file_id: "ru-photo" }],
    });
    setPostAdminState(backendDb, 42, "edit_en", draftId, 99);
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,admin_id,chat_id,media_group_id,action,draft_id,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('en-edit',42,42,'group','edit_en',?,'English replacement','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(
        draftId,
        JSON.stringify([
          { type: "photo", file_id: "en-photo-1" },
          { type: "photo", file_id: "en-photo-2" },
        ]),
      );
    const fakeBot = {
      api: { sendMessage: mock(async () => ({ message_id: 100, date: 1, chat: { id: 42, type: "private" as const } })) },
    } as unknown as Bot;

    expect(await finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" }))).toBe(1);
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM drafts").get()).toEqual({ count: 1 });
    const draft = backendDb.sqlite
      .prepare("SELECT text_ru, text_en_approved, media_ru_json, media_en_json FROM drafts WHERE id=?")
      .get(draftId) as {
      text_ru: string;
      text_en_approved: string;
      media_ru_json: string;
      media_en_json: string;
    };
    expect(draft.text_ru).toBe("Русский исходник");
    expect(draft.text_en_approved).toBe("English replacement");
    expect(JSON.parse(draft.media_ru_json)).toEqual([{ type: "photo", file_id: "ru-photo" }]);
    expect(JSON.parse(draft.media_en_json)).toEqual([
      { type: "photo", file_id: "en-photo-1" },
      { type: "photo", file_id: "en-photo-2" },
    ]);
    expect(getPostAdminState(backendDb, 42)).toMatchObject({ action: null, draft_id: null });
  });

  it("claims one pending album only once when Telegram workers overlap", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,admin_id,chat_id,media_group_id,action,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('once',42,42,'group','new_post','Album caption','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(
        JSON.stringify([
          { type: "photo", file_id: "one" },
          { type: "photo", file_id: "two" },
        ]),
      );
    const fakeBot = {
      api: { sendMessage: mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } })) },
    } as unknown as Bot;

    const completed = await Promise.all([
      finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" })),
      finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" })),
    ]);
    expect(completed).toEqual([1, 0]);
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM drafts").get()).toEqual({ count: 1 });
    expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_albums").get() as { count: number }).count).toBe(0);
  });
});

describe("Telegram entity HTML", () => {
  it("renders links and line breaks without exposing raw markup", () => {
    expect(entitiesToHtml("See link\nnext", [{ type: "text_link", offset: 4, length: 4, url: "https://example.com/?a=1&b=2" }])).toBe(
      'See <a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">link</a><br>next',
    );
  });

  it("renders every supported Telegram formatting entity safely", () => {
    const text = "bold italic under strike code";
    expect(
      entitiesToHtml(text, [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 5, length: 6 },
        { type: "underline", offset: 12, length: 5 },
        { type: "strikethrough", offset: 18, length: 6 },
        { type: "code", offset: 25, length: 4 },
      ]),
    ).toBe("<strong>bold</strong> <em>italic</em> <u>under</u> <s>strike</s> <code>code</code>");
  });
});
