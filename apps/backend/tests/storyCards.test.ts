import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { type BackendDb, openBackendDb } from "../src/db/client.js";
import { drafts, postLocales, publishJobs, siteJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { backfillTextStoryCards } from "../src/operations/story-card-backfill.js";
import { localizeTargetPayload } from "../src/publishing/payload.js";
import { createPublicationPlan } from "../src/publishing/publication-plan.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { buildStoryCardCopy } from "../src/story-cards/copy.js";
import { discardDraftStoryCards, readyStoryCardMedia, setStoryPublishMode, storyCardsForDraft } from "../src/story-cards/store.js";
import { runStoryCardCycle } from "../src/story-cards/worker.js";

let backendDb: BackendDb | null = null;
const temporaryDirectories: string[] = [];

afterEach(() => {
  backendDb?.close();
  backendDb = null;
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("text Story cards", () => {
  it("extracts a leading emoji and wraps a stable six-line headline", () => {
    const copy = buildStoryCardCopy(
      "🚨 СЛИВ: Две модели OpenAI с кодовыми именами Zinc и Magnesium были замечены в DesignArena. Остальной пост не нужен.",
    );
    expect(copy.emoji).toBe("🚨");
    expect(copy.headline).toEndWith("DesignArena.");
    expect(copy.lines.length).toBeGreaterThan(2);
    expect(copy.lines.length).toBeLessThanOrEqual(6);
    expect(copy.boldLineCount).toBe(2);
  });

  it("queues RU and EN automatically and renders both through the isolated process", async () => {
    backendDb = openBackendDb(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "story-card-test-"));
    temporaryDirectories.push(directory);
    const assets = path.resolve("apps/backend/assets/story-card");
    const renderer = path.resolve("apps/backend/src/story-cards/renderer-process.ts");
    const config = loadConfig({
      DATA_DIR: directory,
      STORY_CARD_DIR: directory,
      STORY_CARD_ASSETS_DIR: assets,
      STORY_CARD_RENDERER_ENTRY: renderer,
    });
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "⚡ ChatGPT достиг примерно миллиарда еженедельно активных пользователей.",
      textEn: "⚡ ChatGPT reached approximately one billion weekly active users.",
      entities: [],
      media: [],
    });

    expect(storyCardsForDraft(backendDb, draftId).map((card) => card.status)).toEqual(["queued", "queued"]);
    expect(await runStoryCardCycle(config, backendDb)).toBe(1);
    expect(await runStoryCardCycle(config, backendDb)).toBe(1);
    const media = readyStoryCardMedia(backendDb, draftId);
    expect(media?.ru.role).toBe("text_story_card");
    const metadata = await sharp(String(media?.ru.localPath)).metadata();
    expect(metadata).toMatchObject({ width: 1080, height: 1920, format: "jpeg" });
  }, 20_000);

  it("keeps generated cards out of ordinary targets and gates all Story targets with one decision", () => {
    const storyCards = {
      ru: { type: "IMAGE", localPath: "/cards/ru.jpg", storyLocalPath: "/cards/ru.jpg" },
      en: { type: "IMAGE", localPath: "/cards/en.jpg", storyLocalPath: "/cards/en.jpg" },
    };
    const draft = {
      channel_message_id: 10,
      text_ru: "Русский текст",
      text_en_machine: "English text",
      text_en_approved: null,
      targets_json: JSON.stringify({
        telegram: true,
        site_ru: true,
        site_en: true,
        telegram_stories: true,
        instagram_stories_ru: true,
        instagram_stories: true,
      }),
      media_ru_json: null,
      media_en_json: null,
      text_ru_entities_json: "[]",
      text_en_entities_json: "[]",
      story_publish_mode: "site_only",
    };
    const siteOnly = createPublicationPlan(
      draft as never,
      1,
      2,
      { mode: "immediate", ruAt: "2026-07-29T10:00:00.000Z", enAt: "2026-07-29T10:00:00.000Z" },
      "2026-07-29T10:00:00.000Z",
      undefined,
      storyCards,
    );
    expect(siteOnly.targets).toMatchObject({
      telegram: true,
      site_ru: true,
      site_en: true,
      telegram_stories: false,
      instagram_stories_ru: false,
      instagram_stories: false,
    });
    expect(siteOnly.locales[0]?.mediaJson).toEqual([storyCards.ru]);
    expect(localizeTargetPayload(siteOnly.payload, "telegram").media).toEqual([]);

    const withStories = createPublicationPlan(
      { ...draft, story_publish_mode: "all" } as never,
      1,
      2,
      { mode: "immediate", ruAt: "2026-07-29T10:00:00.000Z", enAt: "2026-07-29T10:00:00.000Z" },
      "2026-07-29T10:00:00.000Z",
      undefined,
      storyCards,
    );
    expect(withStories.targets.telegram_stories).toBe(true);
    expect(localizeTargetPayload(withStories.payload, "telegram_stories").media).toEqual([
      expect.objectContaining({ localPath: "/cards/ru.jpg", storyLocalPath: "/cards/ru.jpg" }),
    ]);
  });

  it("stores the final bundle decision durably", () => {
    backendDb = openBackendDb(":memory:");
    const draftId = createDraftFromMessage(backendDb, 42, { text: "Text", textEn: "Text", entities: [], media: [] });
    setStoryPublishMode(backendDb, draftId, "all");
    expect(backendDb.db.select().from(drafts).where(eq(drafts.id, draftId)).get()?.storyPublishMode).toBe("all");
  });

  it("backfills a published site's empty media without requeueing social delivery", async () => {
    backendDb = openBackendDb(":memory:");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "story-card-backfill-test-"));
    temporaryDirectories.push(directory);
    const config = loadConfig({
      DATA_DIR: directory,
      STORY_CARD_DIR: directory,
      STORY_CARD_ASSETS_DIR: path.resolve("apps/backend/assets/story-card"),
      STORY_CARD_RENDERER_ENTRY: path.resolve("apps/backend/src/story-cards/renderer-process.ts"),
    });
    const draftId = createDraftFromMessage(backendDb, 42, {
      text: "🚨 СЛИВ: Две модели OpenAI появились в DesignArena.",
      textEn: "🚨 LEAK: Two OpenAI models appeared in DesignArena.",
      entities: [],
      media: [],
    });
    discardDraftStoryCards(backendDb, draftId);
    const postId = publishDraftToQueue(backendDb, draftId);
    const socialJobsBefore = backendDb.db.select().from(publishJobs).all().length;

    const dryRun = await backfillTextStoryCards(backendDb, config, `post:${postId}`, false);
    expect(dryRun).toMatchObject({ applied: false, count: 2 });
    expect(storyCardsForDraft(backendDb, draftId)).toHaveLength(0);

    const applied = await backfillTextStoryCards(backendDb, config, `post:${postId}`, true);
    expect(applied).toMatchObject({ applied: true, count: 2 });
    expect(backendDb.db.select().from(postLocales).where(eq(postLocales.postId, postId)).all()).toSatisfy((locales) =>
      locales.every((locale) => Array.isArray(locale.mediaJson) && locale.mediaJson.length === 1),
    );
    expect(backendDb.db.select().from(publishJobs).all()).toHaveLength(socialJobsBefore);
    expect(backendDb.db.select().from(siteJobs).where(eq(siteJobs.postId, postId)).all().at(-1)?.reason).toBe("text_story_card_backfill");
  }, 20_000);
});
