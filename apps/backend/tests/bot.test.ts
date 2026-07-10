import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import { createDraftFromMessage, finalizePendingAlbums, publishDraftToQueue } from "../src/bot.js";
import { loadConfig } from "../src/config.js";
import { openBackendDb, type BackendDb } from "../src/db/client.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

describe("Telegram controller flow", () => {
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
    const siteJobs = backendDb.sqlite.prepare("SELECT status, reason FROM site_jobs WHERE post_id=?").all(postId) as Record<string, unknown>[];
    const locales = backendDb.sqlite.prepare("SELECT locale, site_enabled FROM post_locales WHERE post_id=? ORDER BY locale").all(postId) as Record<string, unknown>[];

    expect(draft).toMatchObject({ status: "published", post_id: postId });
    expect(jobs.map((job) => job.target)).toEqual([
      "bluesky", "devto", "facebook", "facebook_ru", "github_en", "github_ru", "instagram_stories", "instagram_stories_ru",
      "linkedin", "mastodon", "telegram", "telegram_stories", "threads_en", "threads_ru", "x",
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

    expect(backendDb.sqlite.prepare("SELECT status, scheduled_at, scheduled_en_at FROM drafts WHERE id=?").get(draftId)).toEqual({ status: "scheduled", scheduled_at: ruAt.toISOString(), scheduled_en_at: enAt.toISOString() });
    const jobs = backendDb.sqlite.prepare("SELECT target, publish_at FROM publish_jobs WHERE post_id=?").all(postId) as Array<{ target: string; publish_at: string }>;
    expect(jobs.find((job) => job.target === "telegram")?.publish_at).toBe(ruAt.toISOString());
    expect(jobs.find((job) => job.target === "linkedin")?.publish_at).toBe(enAt.toISOString());
    expect(backendDb.sqlite.prepare("SELECT reason, next_attempt_at FROM site_jobs WHERE post_id=? ORDER BY reason").all(postId)).toEqual([
      { reason: "publish_en", next_attempt_at: enAt.toISOString() },
      { reason: "publish_ru", next_attempt_at: ruAt.toISOString() },
    ]);
  });

  it("finalizes a durable Telegram media album into one draft", async () => {
    backendDb = openBackendDb(":memory:");
    backendDb.sqlite.prepare(`INSERT INTO pending_albums(id,admin_id,chat_id,media_group_id,text_ru,text_entities_json,media_json,notified,updated_at)
      VALUES ('album',42,42,'group','Album caption','[]',?,1,'2000-01-01T00:00:00.000Z')`)
      .run(JSON.stringify([{ type: "photo", file_id: "one" }, { type: "photo", file_id: "two" }]));
    const sendMessage = vi.fn(async () => ({ message_id: 1, date: 1, chat: { id: 42, type: "private" as const } }));
    const fakeBot = { api: { sendMessage } } as unknown as Bot;

    expect(await finalizePendingAlbums(fakeBot, backendDb, loadConfig({ CONTROLLER_ALBUM_SETTLE_SECONDS: "1" }))).toBe(1);
    const draft = backendDb.sqlite.prepare("SELECT text_ru, media_ru_json FROM drafts").get() as { text_ru: string; media_ru_json: string };
    expect(draft.text_ru).toBe("Album caption");
    expect(JSON.parse(draft.media_ru_json)).toHaveLength(2);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM pending_albums").get() as { count: number }).count).toBe(0);
  });
});
