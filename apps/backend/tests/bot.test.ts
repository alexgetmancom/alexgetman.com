import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Bot } from "grammy";
import { finalizePendingAlbums } from "../src/bot/albums.js";
import { getConversationState, saveConversationState } from "../src/bot/conversation-state.js";
import type { PostWizardStep } from "../src/bot/post-flow.js";
import { draftPreview } from "../src/bot/preview.js";
import { postProgress } from "../src/bot/progress.js";
import { DEFAULT_TARGETS, TARGETS, targetLocale } from "../src/botTargets.js";
import { createDraftFromMessage, requireDraft } from "../src/content/drafts.js";
import { entitiesToHtml } from "../src/content/text.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { botUiSettings } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { threadsPreviewText } from "../src/interfaces/telegram/delivery-previews.js";
import { cancelDraft, scheduledDrafts } from "../src/publishing/draft-lifecycle.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { reconcilePublication } from "../src/publishing/queue.js";
import { postDeliveryProjections } from "../src/studio/projections.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: UnsafeBackendDb | null = null;

function persistPostState(db: UnsafeBackendDb, actorId: number, step: PostWizardStep, draftId: number, controlMessageId: number): number {
  return saveConversationState(db, actorId, {
    kind: "post",
    draftId,
    step: step.type,
    data:
      step.type === "edit_text" || step.type === "replace_media" || step.type === "schedule_manual"
        ? { locale: step.locale }
        : step.type === "schedule_confirm"
          ? { locale: step.locale, value: step.value.toISOString() }
          : {},
    controlMessageId,
  }).revision;
}

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
    expect(JSON.stringify(preview.keyboard)).toContain(`view:${draftId}:platforms`);
    expect(JSON.stringify(preview.keyboard)).toContain(`edit_ru:${draftId}`);
    expect(JSON.stringify(preview.keyboard)).toContain(`edit_en:${draftId}`);
    expect(JSON.stringify(preview.keyboard)).not.toContain(`edit_menu:${draftId}`);
    expect(JSON.stringify(preview.keyboard)).toContain(`sources:${draftId}`);
    expect(JSON.stringify(preview.keyboard)).not.toContain("use_ru_media");
  });

  it("renders post preview and confirmation controls in the selected interface language", () => {
    backendDb = openBackendDb(":memory:");
    backendDb.db.insert(botUiSettings).values({ actorId: 42, locale: "ru", updatedAt: new Date().toISOString() }).run();
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Карточка", textEn: "Card", entities: [], media: [] });
    const preview = draftPreview(backendDb, draftId, loadConfig({}));

    expect(preview.text).toContain("Режим: *Ручной*");
    expect(JSON.stringify(preview.keyboard)).toContain("Опубликовать");
    expect(JSON.stringify(preview.keyboard)).toContain("Запланировать");
  });

  it("escapes draft Markdown before embedding copy in the control card", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "*bold* [link] _under_ `code`",
      textEn: "*English* [link] _under_ `code`",
      entities: [],
      media: [],
    });

    const preview = draftPreview(backendDb, draftId, loadConfig({}));

    expect(preview.text).toContain("\\*bold\\* \\[link\\] \\_under\\_ \\`code\\`");
    expect(preview.text).toContain("\\*English\\* \\[link\\] \\_under\\_ \\`code\\`");
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
      "instagram_stories",
      "instagram_stories_ru",
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
    expect(jobs.find((job) => job.target === "threads_en")?.publish_at).toBe(enAt.toISOString());
    expect(backendDb.sqlite.prepare("SELECT reason, next_attempt_at FROM site_jobs WHERE post_id=? ORDER BY reason").all(postId)).toEqual([
      { reason: "publish_en", next_attempt_at: enAt.toISOString() },
      { reason: "publish_ru", next_attempt_at: ruAt.toISOString() },
    ]);
    expect(scheduledDrafts(backendDb)).toEqual([{ id: draftId, scheduledAt: ruAt.toISOString(), scheduledEnAt: enAt.toISOString() }]);
  });

  it("renders compact controls for a scheduled post", () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ ADMIN_IDS: "42" });
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Scheduled", textEn: "Scheduled", entities: [], media: [] });
    const at = new Date(Date.now() + 60 * 60_000);
    publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt: at, enAt: at });

    const preview = draftPreview(backendDb, draftId, config);
    const buttons = preview.keyboard.inline_keyboard.flat().map((button) => button.text);
    expect(buttons).toEqual(["🕒 Change time", "✏️ Edit details", "🗑 Cancel publication", "← Work queue"]);
    expect(buttons).not.toContain("▶️ Publish now");
    expect(buttons).not.toContain("🗑 Delete draft");

    const confirmation = draftPreview(backendDb, draftId, config, "confirm_cancel");
    expect(confirmation.text).toContain("Cancel this publication?");
    expect(JSON.stringify(confirmation.keyboard)).toContain("cancel_confirm");

    const schedule = draftPreview(backendDb, draftId, config, "schedule");
    expect(JSON.stringify(schedule.keyboard)).toContain("schedule_ru");
    expect(JSON.stringify(schedule.keyboard)).toContain("schedule_en");
    expect(JSON.stringify(schedule.keyboard)).not.toContain("sched_scope");
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

  it("does not duplicate a final site locale when a publication is replanned", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Repeat site", textEn: "Repeat site", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE post_id=? AND reason='publish_en'").run(postId);

    publishDraftToQueue(backendDb, draftId);

    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM site_jobs WHERE post_id=? AND reason='publish_en'").get(postId)).toEqual(
      {
        count: 1,
      },
    );
  });

  it("keeps publication history when only the site has reached a final state", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Site history", textEn: "Site history", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE post_id=? AND reason='publish_ru'").run(postId);

    cancelDraft(backendDb, draftId);

    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publications WHERE post_id=?").get(postId)).toEqual({ count: 1 });
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM posts WHERE post_id=?").get(postId)).toEqual({ count: 1 });
    expect(backendDb.sqlite.prepare("SELECT status FROM site_jobs WHERE post_id=? ORDER BY reason").all(postId)).toEqual([
      { status: "cancelled" },
      { status: "published" },
    ]);
  });

  it("does not publish a locale whose scheduled time has not been chosen yet", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Partial schedule",
      textEn: "Partial schedule",
      entities: [],
      media: [],
    });
    const ruAt = new Date(Date.now() + 60_000);
    const postId = publishDraftToQueue(backendDb, draftId, {
      mode: "scheduled",
      ruAt,
      enAt: null,
    });
    const jobs = backendDb.sqlite
      .prepare("SELECT target, publish_at FROM publish_jobs WHERE post_id=? ORDER BY target")
      .all(postId) as Array<{
      target: string;
      publish_at: string;
    }>;
    const enSite = backendDb.sqlite.prepare("SELECT next_attempt_at FROM site_jobs WHERE post_id=? AND reason='publish_en'").get(postId);

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => job.publish_at === ruAt.toISOString())).toBe(true);
    expect(jobs.some((job) => job.target.endsWith("_en"))).toBe(false);
    expect(enSite).toBeNull();
    expect(backendDb.sqlite.prepare("SELECT published_at FROM post_locales WHERE post_id=? AND locale='en'").get(postId)).toEqual({
      published_at: null,
    });
  });

  it("keeps a partial scheduled publication open until the missing locale is scheduled", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Partial lifecycle",
      textEn: "Partial lifecycle",
      entities: [],
      media: [],
    });
    const ruAt = new Date(Date.now() + 60_000);
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt: null });

    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("UPDATE site_jobs SET status='published' WHERE post_id=?").run(postId);
    reconcilePublication(backendDb, postId);

    expect(backendDb.sqlite.prepare("SELECT status FROM publications WHERE post_id=?").get(postId)).toEqual({ status: "scheduled" });
    expect(backendDb.sqlite.prepare("SELECT status FROM drafts WHERE id=?").get(draftId)).toEqual({ status: "scheduled" });

    const enAt = new Date(Date.now() + 120_000);
    publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
    expect(backendDb.sqlite.prepare("SELECT publish_at FROM publish_jobs WHERE post_id=? AND target='threads_en'").get(postId)).toEqual({
      publish_at: enAt.toISOString(),
    });
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
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='failed' WHERE post_id=? AND target='threads_ru'").run(postId);
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
      .prepare("SELECT target,payload_json FROM publish_jobs WHERE target IN ('telegram','threads_ru','threads_en') ORDER BY target")
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
    for (const target of ["threads_en"]) {
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
    expect(jobs).toHaveLength(TARGETS.filter(({ id, kind }) => kind !== "site" && DEFAULT_TARGETS[id]).length);
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

  it("retains source formatting entities in the Telegram delivery preview", () => {
    backendDb = openBackendDb(":memory:");
    const entities = [
      { type: "bold", offset: 0, length: 6 },
      { type: "text_link", offset: 9, length: 6, url: "https://example.com" },
    ];
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Жирный и ссылка",
      textEn: "Bold and link",
      entities,
      media: [],
    });

    const preview = postDeliveryProjections(requireDraft(backendDb, draftId)).projections.find((item) => item.locale === "ru");
    expect(preview?.entities).toEqual(entities);
    expect(preview?.targets).not.toContain("telegram_stories");
    expect(preview?.unavailableTargets).toContain("telegram_stories");
  });

  it("warns before publishing when selected Stories targets have no media", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Text only", textEn: "Text only", entities: [], media: [] });

    const preview = draftPreview(backendDb, draftId, loadConfig({}), "confirm_publish");
    expect(preview.text).toContain("Will not be sent (no media): Telegram Stories, Instagram Stories RU, Instagram Stories EN.");
  });

  it("shows the Threads character budget instead of a reply chain", () => {
    const preview = threadsPreviewText("threads_ru", "Short enough.");
    expect(preview).toContain("🧵 Threads RU");
    expect(preview).toContain("/500");
    expect(preview).not.toContain("⚠️");
  });

  it("flags a Threads preview that no longer fits one post", () => {
    const preview = threadsPreviewText("threads_ru", "First segment. ".repeat(40));
    expect(preview).toContain("⚠️");
    expect(preview).not.toContain("①");
  });

  it("appends one hidden link to a Threads post that has room, and says so", () => {
    const link = [{ type: "text_link", offset: 0, length: 5, url: "https://example.com/guide" }];
    const preview = threadsPreviewText("threads_ru", "Short post", link, false, "ru");
    expect(preview).toContain("🔗 https://example.com/guide");
    expect(preview).toContain("ссылка влезла");
  });

  it("draws the link boundary at the same character the publisher does", () => {
    const link = [{ type: "text_link", offset: 0, length: 5, url: "https://example.com/guide" }];
    // The publisher is asserted on the same 470/471 pair in threadsPublisher.test.ts.
    // These two must never disagree: the preview is the only place the decision
    // is visible before it happens.
    expect(threadsPreviewText("threads_ru", "a".repeat(470), link, false, "ru")).toContain("ссылка влезла");
    expect(threadsPreviewText("threads_ru", "a".repeat(471), link, false, "ru")).toContain("ссылка убрана");
  });

  it("drops the link when it does not fit and reports how many characters were missing", () => {
    const link = [{ type: "text_link", offset: 0, length: 5, url: "https://example.com/guide" }];
    const preview = threadsPreviewText("threads_ru", "А".repeat(490), link, false, "ru");
    expect(preview).not.toContain("https://example.com/guide");
    // 490 text + 5 for the "\n\n🔗 " prefix (🔗 is a surrogate pair) + 25 for the
    // url = 520, i.e. 20 over the 500 budget.
    expect(preview).toContain("не хватило 20");
  });

  it("renders a live post progress card from publication job states", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Progress", textEn: "Progress", entities: [], media: [] });
    const postId = publishDraftToQueue(backendDb, draftId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE post_id=? AND target='telegram'").run(postId);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='publishing' WHERE post_id=? AND target='threads_en'").run(postId);
    backendDb.sqlite
      .prepare("UPDATE publish_jobs SET status='failed', last_error='rate limit' WHERE post_id=? AND target='threads_ru'")
      .run(postId);

    const progress = postProgress(backendDb, draftId, true);
    expect(progress.text).toContain("Progress: *2 / 8*");
    expect(progress.text).toContain("✅ Published: 1");
    expect(progress.text).toContain("🔄 Publishing: 1");
    expect(progress.text).toContain("❌ Failed: 1");
    expect(progress.text).toContain("❌ Threads RU — rate limit");
    expect(JSON.stringify(progress.keyboard)).toContain(`progress:${draftId}`);
  });

  it("finalizes a durable Telegram media album into one draft", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('album',42,42,'group','Album caption','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(
        JSON.stringify([
          { type: "photo", file_id: "one", local_path: "/imported/one.jpg" },
          { type: "photo", file_id: "two", local_path: "/imported/two.jpg" },
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

  it("keeps one draft when the control card fails after the album is finalized", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('card-fails',42,42,'group','Album caption','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(JSON.stringify([{ type: "photo", file_id: "one", local_path: "/imported/one.jpg" }]));
    const sendMessage = mock(async () => {
      throw new Error("Bad Request: message is too long");
    });
    const fakeBot = { api: { sendMessage } } as unknown as Bot;
    const config = loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" });

    expect(await finalizePendingAlbums(fakeBot, backendDb, config)).toBe(1);
    expect(await finalizePendingAlbums(fakeBot, backendDb, config)).toBe(0);
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM drafts").get()).toEqual({ count: 1 });
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
    persistPostState(backendDb, 42, { type: "edit_text", locale: "en" }, draftId, 99);
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,step,step_data_json,draft_id,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('en-edit',42,42,'group','edit_text','{"locale":"en"}',?,'English replacement','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(
        draftId,
        JSON.stringify([
          { type: "photo", file_id: "en-photo-1", local_path: "/imported/en-photo-1.jpg" },
          { type: "photo", file_id: "en-photo-2", local_path: "/imported/en-photo-2.jpg" },
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
      { type: "photo", file_id: "en-photo-1", local_path: "/imported/en-photo-1.jpg" },
      { type: "photo", file_id: "en-photo-2", local_path: "/imported/en-photo-2.jpg" },
    ]);
    expect(getConversationState(backendDb, 42, "post")).toBeNull();
  });

  it("discards an album captured by an older conversation revision", async () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "Russian source",
      textEn: "English source",
      entities: [],
      media: [],
    });
    const staleRevision = persistPostState(backendDb, 42, { type: "edit_text", locale: "en" }, draftId, 99);
    persistPostState(backendDb, 42, { type: "edit_text", locale: "ru" }, draftId, 100);
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,step,step_data_json,draft_id,state_revision,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('stale-revision',42,42,'group','edit_text','{"locale":"en"}',?,?,'Must not replace','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(draftId, staleRevision, JSON.stringify([{ type: "photo", file_id: "old", local_path: "/imported/old.jpg" }]));
    const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const fakeBot = { api: { sendMessage } } as unknown as Bot;

    expect(await finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" }))).toBe(0);
    expect(backendDb.sqlite.prepare("SELECT text_en_approved FROM drafts WHERE id=?").get(draftId)).toEqual({ text_en_approved: null });
    expect(backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_albums").get()).toEqual({ count: 0 });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(getConversationState(backendDb, 42, "post")?.data).toEqual({ locale: "ru" });
  });

  it("claims one pending album only once when Telegram workers overlap", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,step,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('once',42,42,'group','new_post','Album caption','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(
        JSON.stringify([
          { type: "photo", file_id: "one", local_path: "/imported/one.jpg" },
          { type: "photo", file_id: "two", local_path: "/imported/two.jpg" },
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

  it("reclaims a stale album claim left by a crashed worker", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,step,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('stale-claim',42,42,'group','new_post','Album caption','[]',?,2,'2000-01-01T00:00:00.000Z')`)
      .run(JSON.stringify([{ type: "photo", file_id: "one", local_path: "/imported/one.jpg" }]));
    const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const fakeBot = { api: { sendMessage } } as unknown as Bot;

    expect(await finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" }))).toBe(1);
    expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_albums").get() as { count: number }).count).toBe(0);
  });

  it("gives up on an album that keeps failing instead of retrying it forever", async () => {
    const db = openBackendDb(":memory:");
    backendDb = db;
    db.sqlite
      .prepare(`INSERT INTO pending_albums(id,actor_id,chat_id,media_group_id,step,step_data_json,draft_id,text_ru,text_entities_json,media_json,notified,attempt_count,updated_at)
      VALUES ('doomed',42,42,'group','edit_text','{"locale":"ru"}',4242,'Caption','[]',?,1,0,'2000-01-01T00:00:00.000Z')`)
      .run(JSON.stringify([{ type: "photo", file_id: "one", local_path: "/imported/one.jpg" }]));
    const sendMessage = mock(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const fakeBot = { api: { sendMessage } } as unknown as Bot;
    const config = loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" });
    const attempts = () =>
      (db.sqlite.prepare("SELECT attempt_count AS n FROM pending_albums WHERE id='doomed'").get() as { n: number } | null)?.n ?? null;

    // The draft id does not exist, so finalization fails deterministically.
    for (let run = 1; run <= 4; run += 1) {
      expect(await finalizePendingAlbums(fakeBot, db, config)).toBe(0);
      expect(attempts()).toBe(run);
      db.sqlite.prepare("UPDATE pending_albums SET updated_at='2000-01-01T00:00:00.000Z'").run();
    }
    expect(await finalizePendingAlbums(fakeBot, db, config)).toBe(0);
    expect(attempts()).toBeNull();
    expect((db.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_albums").get() as { count: number }).count).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

  it("nests entities that share a range instead of tearing the markup", () => {
    expect(
      entitiesToHtml("click here", [
        { type: "text_link", offset: 0, length: 10, url: "https://example.com/" },
        { type: "bold", offset: 0, length: 5 },
      ]),
    ).toBe('<a href="https://example.com/" rel="noopener noreferrer"><strong>click</strong> here</a>');
  });

  it("nests an entity fully contained in a longer one", () => {
    expect(
      entitiesToHtml("alpha beta gamma", [
        { type: "italic", offset: 0, length: 16 },
        { type: "bold", offset: 6, length: 4 },
      ]),
    ).toBe("<em>alpha <strong>beta</strong> gamma</em>");
  });

  it("escapes the href of a bare url entity and keeps schemeless domains https", () => {
    expect(entitiesToHtml("go example.com now", [{ type: "url", offset: 3, length: 11 }])).toBe(
      'go <a href="https://example.com" rel="noopener noreferrer">example.com</a> now',
    );
  });

  it("drops an entity whose range runs past the text", () => {
    expect(entitiesToHtml("short", [{ type: "bold", offset: 2, length: 99 }])).toBe("short");
  });
});
