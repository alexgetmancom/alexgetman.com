import { Bot, InlineKeyboard, type Context } from "grammy";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import { DEFAULT_TARGETS, PRESETS, TARGETS, TARGET_BY_ID, isSiteTarget, targetLocale, type TargetId } from "./botTargets.js";
import { log } from "./logger.js";
import { formatMsk, nextPublishingSlot, parseManualSchedule, schedulePreset } from "./publishingSchedule.js";
import { enqueuePublishJob } from "./queue/publish.js";
import { translateToEnglish } from "./translation.js";
import { generateStoryMedia } from "./media/story.js";
import { localizeTargetPayload } from "./publicationPayload.js";

export function createBot(config: BackendConfig, backendDb: BackendDb): Bot | null {
  if (!config.controllerBotToken) {
    log("warn", "Telegram bot token is not configured; bot is disabled");
    return null;
  }
  const bot = new Bot(config.controllerBotToken, {
    client: {
      apiRoot: config.TELEGRAM_API_BASE_URL,
    },
  });
  bindBotHandlers(bot, config, backendDb);
  bot.catch((error) => log("error", "grammY handler failed", { error: String(error.error) }));
  return bot;
}

export function bindBotHandlers(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  bot.command("start", (ctx) => ctx.reply("Send draft text with optional photo/video. Use Publish after preview."));
  bot.command("pipeline_status", (ctx) => ctx.reply(`${config.COMMAND_CENTER_URL.replace(/\/$/, "")}/pipeline-status`));
  bot.on("message", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) {
      await ctx.reply("Forbidden");
      return;
    }
    const state = getAdminState(backendDb, Number(ctx.from?.id));
    const extracted = extractMessage(ctx);
    const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
    if (mediaGroupId && extracted.media.length > 0) {
      const isNew = appendPendingAlbum(backendDb, {
        adminId: Number(ctx.from?.id),
        chatId: Number(ctx.chat?.id),
        mediaGroupId,
        text: extracted.text,
        entities: extracted.entities,
        media: extracted.media[0]!,
        action: state?.action ?? null,
        draftId: state?.draft_id ?? null,
      });
      if (isNew) await ctx.reply("Album received. I will create or update the draft in a few seconds.");
      return;
    }
    if (state?.action && state.draft_id) {
      await applyAdminState(ctx, backendDb, state.action, state.draft_id);
      return;
    }
    const message = extracted;
    let textEn = message.text;
    try {
      textEn = await translateToEnglish(message.text, config);
    } catch (error) {
      log("warn", "draft translation failed", { error: String(error) });
      textEn = "";
    }
    const draftId = createDraftFromMessage(backendDb, Number(ctx.from?.id), { ...message, textEn });
    await sendDraftPreview(ctx, backendDb, draftId);
  });
  bot.on("callback_query:data", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: "Forbidden" });
      return;
    }
    await handleDraftCallback(ctx, backendDb, config);
  });
}

export async function processTelegramUpdate(bot: Bot, update: Parameters<Bot["handleUpdate"]>[0]): Promise<void> {
  await bot.handleUpdate(update);
}

export function createDraftFromMessage(backendDb: BackendDb, adminId: number, message: DraftMessage): number {
  const now = new Date().toISOString();
  const targets = { ...DEFAULT_TARGETS };
  const result = backendDb.sqlite
    .prepare(
      `INSERT INTO drafts(admin_id, status, text_ru, text_en_machine, text_en_approved, targets_json, media_ru_json, text_ru_entities_json, created_at, updated_at)
       VALUES (?, 'needs_review', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      adminId,
      message.text,
      message.textEn ?? message.text,
      message.textEn ?? message.text,
      JSON.stringify(targets),
      message.media.length ? JSON.stringify(message.media) : null,
      JSON.stringify(message.entities),
      now,
      now,
    );
  return Number(result.lastInsertRowid);
}

async function handleDraftCallback(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const [action, first, second] = parts;
  const draftId = Number(action === "preset" ? second : action?.startsWith("sched_") ? parts.at(-1) : first);
  if (!Number.isSafeInteger(draftId)) {
    await ctx.answerCallbackQuery({ text: "Bad draft id" });
    return;
  }
  if (action === "toggle" && second) {
    toggleDraftTarget(backendDb, draftId, second);
    await ctx.answerCallbackQuery({ text: `${second} toggled` });
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "preset" && first && PRESETS[first]) {
    backendDb.sqlite.prepare("UPDATE drafts SET targets_json=?, updated_at=? WHERE id=?").run(JSON.stringify(PRESETS[first]), new Date().toISOString(), draftId);
    await ctx.answerCallbackQuery({ text: `${first} preset` });
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "edit_ru" || action === "edit_en" || action === "replace_ru_media" || action === "replace_en_media") {
    setAdminState(backendDb, Number(ctx.from?.id), action, draftId);
    await ctx.answerCallbackQuery({ text: "Send the replacement as the next message" });
    await ctx.reply(action.startsWith("edit") ? "Send edited text as the next message." : "Send replacement photo/video as the next message.");
    return;
  }
  if (action === "use_ru_media") {
    backendDb.sqlite.prepare("UPDATE drafts SET media_en_json=NULL, updated_at=? WHERE id=?").run(new Date().toISOString(), draftId);
    await ctx.answerCallbackQuery({ text: "EN media uses RU fallback" });
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "generate_story_ru" || action === "generate_story_en") {
    const locale = action.endsWith("_ru") ? "ru" : "en";
    const draft = requireDraft(backendDb, draftId);
    const source = locale === "en" ? parseJson(draft.media_en_json) ?? parseJson(draft.media_ru_json) : parseJson(draft.media_ru_json);
    const generated = await generateStoryMedia(source, draftId, locale, config);
    const column = locale === "en" ? "media_en_json" : "media_ru_json";
    backendDb.sqlite.prepare(`UPDATE drafts SET ${column}=?, updated_at=? WHERE id=?`).run(JSON.stringify(generated), new Date().toISOString(), draftId);
    await ctx.answerCallbackQuery({ text: `${locale.toUpperCase()} 9:16 generated` });
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "cancel") {
    cancelDraft(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "Cancelled" });
    await ctx.reply(`Draft #${draftId} cancelled.`);
    return;
  }
  if (action === "publish") {
    const postId = publishDraftToQueue(backendDb, draftId);
    await ctx.answerCallbackQuery({ text: "Queued" });
    await ctx.reply(`Draft #${draftId} queued as post #${postId}`);
    return;
  }
  if (action === "schedule") {
    const keyboard = new InlineKeyboard()
      .text("Auto next slots", `sched_auto:${draftId}`).text("+30 min", `sched_preset:plus30:${draftId}`).row()
      .text("+1 hour", `sched_preset:plus60:${draftId}`).text("Today 21:00", `sched_preset:today2100:${draftId}`).row()
      .text("Tomorrow 10:00", `sched_preset:tomorrow1000:${draftId}`).row()
      .text("Manual both", `sched_manual:both:${draftId}`).text("Manual RU", `sched_manual:ru:${draftId}`).text("Manual EN", `sched_manual:en:${draftId}`);
    await ctx.answerCallbackQuery();
    await ctx.reply(`Choose schedule time for draft #${draftId}.`, { reply_markup: keyboard });
    return;
  }
  if (action === "sched_auto") {
    const draft = requireDraft(backendDb, draftId);
    const targets = parseTargets(draft.targets_json);
    const ruAt = hasLocaleTarget(targets, "ru") ? nextPublishingSlot(backendDb, "ru") : null;
    const enAt = hasLocaleTarget(targets, "en") ? nextPublishingSlot(backendDb, "en") : null;
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    await ctx.reply(`Draft #${draftId} scheduled as post #${postId}.\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`);
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "sched_preset" && second) {
    const value = schedulePreset(first!);
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt: value, enAt: value });
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    await ctx.reply(`Draft #${draftId} scheduled as post #${postId}.\nRU/EN: ${formatMsk(value)}`);
    return;
  }
  if (action === "sched_manual" && first) {
    setAdminState(backendDb, Number(ctx.from?.id), `schedule_manual_${first}`, draftId);
    await ctx.answerCallbackQuery({ text: "Send time" });
    await ctx.reply("Send time as HH:MM or DD.MM HH:MM.");
    return;
  }
  await ctx.answerCallbackQuery({ text: "Unknown action" });
}

function cancelDraft(backendDb: BackendDb, draftId: number): void {
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    const publication = backendDb.sqlite.prepare("SELECT post_id FROM publications WHERE draft_id=?").get(draftId) as { post_id?: number } | undefined;
    const postId = publication?.post_id;
    backendDb.sqlite.prepare("UPDATE drafts SET status='cancelled', scheduled_at=NULL, scheduled_en_at=NULL, updated_at=? WHERE id=?").run(now, draftId);
    if (!postId) return;
    const finalCount = backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM publish_jobs WHERE post_id=? AND status IN ('publishing','published','skipped')").get(postId) as { count: number };
    if (finalCount.count > 0) {
      backendDb.sqlite.prepare("UPDATE publish_jobs SET status='cancelled', updated_at=? WHERE post_id=? AND status IN ('queued','failed')").run(now, postId);
      backendDb.sqlite.prepare("UPDATE site_jobs SET status='cancelled', updated_at=? WHERE post_id=? AND status IN ('queued','failed')").run(now, postId);
      return;
    }
    backendDb.sqlite.prepare("DELETE FROM publish_jobs WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("DELETE FROM site_jobs WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("DELETE FROM publication_plans WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("DELETE FROM publication_sources WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("DELETE FROM post_locales WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("DELETE FROM posts WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("DELETE FROM publications WHERE post_id=?").run(postId);
    backendDb.sqlite.prepare("UPDATE drafts SET post_id=NULL, updated_at=? WHERE id=?").run(now, draftId);
  })();
}

export function publishDraftToQueue(
  backendDb: BackendDb,
  draftId: number,
  options: { mode?: "immediate" | "scheduled"; ruAt?: Date | null; enAt?: Date | null } = {},
): number {
  const draft = requireDraft(backendDb, draftId);
  const now = new Date().toISOString();
  const mode = options.mode ?? "immediate";
  const ruAt = mode === "immediate" ? now : options.ruAt?.toISOString() ?? null;
  const enAt = mode === "immediate" ? now : options.enAt?.toISOString() ?? null;
  const existing = backendDb.sqlite.prepare("SELECT post_id FROM publications WHERE draft_id=?").get(draftId) as { post_id?: number } | undefined;
  const postId = existing?.post_id ?? Number(backendDb.sqlite.prepare("INSERT INTO publications(status, draft_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(mode === "immediate" ? "published" : "scheduled", draftId, now, now).lastInsertRowid);
  const messageId = Number(draft.channel_message_id ?? postId);
  const postKey = `post:${postId}`;
  const mediaRu = parseJson(draft.media_ru_json);
  const mediaEn = parseJson(draft.media_en_json) ?? mediaRu;
  const entitiesRu = parseArrayValue(draft.text_ru_entities_json);
  const entitiesEn = parseArrayValue(draft.text_en_entities_json);
  const targets = parseTargets(draft.targets_json);
  const textRu = String(draft.text_ru ?? "");
  const textEn = String(draft.text_en_approved ?? draft.text_en_machine ?? draft.text_ru ?? "");
  const slugRu = slugify(firstLine(textRu), postId);
  const slugEn = slugify(firstLine(textEn), postId);
  const payload = {
    draft_id: draftId,
    post_id: postId,
    title: firstLine(textEn),
    text: textRu,
    text_ru: textRu,
    text_en: textEn,
    bodyMarkdown: textEn,
    media: mediaRu,
    media_en: mediaEn,
    entities_ru: entitiesRu,
    entities_en: entitiesEn,
    date: ruAt ?? enAt ?? now,
    publish_at_ru: ruAt,
    publish_at_en: enAt,
    targets,
    slug_ru: slugRu,
    slug_en: slugEn,
    has_ru: Boolean(targets.site_ru),
    has_en: Boolean(targets.site_en),
  };

  backendDb.sqlite.transaction(() => {
    backendDb.sqlite
      .prepare(`INSERT INTO posts(post_key, post_id, source, channel, message_id, date_utc, text, text_en, media_json, media_count, created_at, updated_at, raw_json)
        VALUES (?, ?, 'bot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_key) DO UPDATE SET post_id=excluded.post_id, date_utc=excluded.date_utc, text=excluded.text, text_en=excluded.text_en, media_json=excluded.media_json, media_count=excluded.media_count, updated_at=excluded.updated_at, raw_json=excluded.raw_json`)
      .run(postKey, postId, "controller", messageId, ruAt ?? enAt ?? now, payload.text, payload.text_en, JSON.stringify(mediaRu ?? []), Array.isArray(mediaRu) ? mediaRu.length : 0, now, now, JSON.stringify(payload));
    backendDb.sqlite.prepare(`INSERT INTO post_locales(post_id, locale, slug, text, html, entities_json, media_json, site_enabled, published_at, updated_at)
      VALUES (?, 'ru', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id, locale) DO UPDATE SET slug=excluded.slug, text=excluded.text, html=excluded.html, entities_json=excluded.entities_json, media_json=excluded.media_json, site_enabled=excluded.site_enabled, published_at=excluded.published_at, updated_at=excluded.updated_at`)
      .run(postId, slugRu, textRu, entitiesToHtml(textRu, entitiesRu), draft.text_ru_entities_json ?? null, JSON.stringify(mediaRu ?? []), targets.site_ru ? 1 : 0, targets.site_ru ? ruAt : null, now);
    backendDb.sqlite.prepare(`INSERT INTO post_locales(post_id, locale, slug, text, html, entities_json, media_json, site_enabled, published_at, updated_at)
      VALUES (?, 'en', ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id, locale) DO UPDATE SET slug=excluded.slug, text=excluded.text, html=excluded.html, entities_json=excluded.entities_json, media_json=excluded.media_json, site_enabled=excluded.site_enabled, published_at=excluded.published_at, updated_at=excluded.updated_at`)
      .run(postId, slugEn, textEn, entitiesToHtml(textEn, entitiesEn), draft.text_en_entities_json ?? null, JSON.stringify(mediaEn ?? []), targets.site_en ? 1 : 0, targets.site_en ? enAt : null, now);
    backendDb.sqlite.prepare(`INSERT INTO publication_plans(post_id, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET plan_json=excluded.plan_json, updated_at=excluded.updated_at`).run(postId, JSON.stringify({ draft_id: draftId, targets, scheduled_at: ruAt, scheduled_en_at: enAt, created_at: now }), now, now);
    backendDb.sqlite.prepare(`INSERT INTO publication_sources(post_id, item_json, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(post_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at`).run(postId, JSON.stringify(payload), now, now);
    backendDb.sqlite.prepare(`INSERT INTO site_source_items(message_id, item_json, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET item_json=excluded.item_json, updated_at=excluded.updated_at`).run(messageId, JSON.stringify(payload), now, now);
    backendDb.sqlite.prepare("DELETE FROM publish_jobs WHERE post_id=? AND status IN ('queued','failed')").run(postId);
    backendDb.sqlite.prepare("DELETE FROM site_jobs WHERE post_id=? AND status IN ('queued','failed')").run(postId);
    for (const [target, enabled] of Object.entries(targets)) {
      if (!enabled || isSiteTarget(target)) continue;
      const publishAt = targetLocale(target) === "en" ? enAt : ruAt;
      enqueuePublishJob(backendDb, { postId, postKey, messageId, target, payload: localizeTargetPayload(payload, target), publishAt });
    }
    for (const [locale, enabled, publishAt] of [["ru", targets.site_ru, ruAt], ["en", targets.site_en, enAt]] as const) {
      if (enabled && publishAt) backendDb.sqlite.prepare("INSERT INTO site_jobs(post_id, message_id, reason, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?)").run(postId, messageId, `publish_${locale}`, publishAt, now, now);
    }
    backendDb.sqlite.prepare("UPDATE drafts SET status=?, post_id=?, publish_mode=?, scheduled_at=?, scheduled_en_at=?, updated_at=? WHERE id=?").run(mode === "immediate" ? "published" : "scheduled", postId, mode, ruAt, enAt, now, draftId);
    backendDb.sqlite.prepare("UPDATE publications SET status=?, updated_at=? WHERE post_id=?").run(mode === "immediate" ? "published" : "scheduled", now, postId);
  })();
  return postId;
}

async function sendDraftPreview(ctx: Context, backendDb: BackendDb, draftId: number): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  await ctx.reply(preview.text, { reply_markup: preview.keyboard });
}

function draftPreview(backendDb: BackendDb, draftId: number): { text: string; keyboard: InlineKeyboard } {
  const draft = backendDb.sqlite.prepare("SELECT * FROM drafts WHERE id=?").get(draftId) as Record<string, unknown>;
  const targets = parseTargets(draft.targets_json);
  const keyboard = new InlineKeyboard();
  keyboard.text("Full", `preset:full:${draftId}`).text("RU only", `preset:ru:${draftId}`).text("EN only", `preset:en:${draftId}`).text("TG only", `preset:tg:${draftId}`).row();
  for (let index = 0; index < TARGETS.length; index += 2) {
    for (const [target, label] of TARGETS.slice(index, index + 2)) keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
    keyboard.row();
  }
  keyboard.text("Edit RU", `edit_ru:${draftId}`).text("Edit EN", `edit_en:${draftId}`).row();
  keyboard.text("Replace RU media", `replace_ru_media:${draftId}`).text("Replace EN media", `replace_en_media:${draftId}`).row();
  keyboard.text("Generate RU 9:16", `generate_story_ru:${draftId}`).text("Generate EN 9:16", `generate_story_en:${draftId}`).row();
  keyboard.text("Use RU media for EN", `use_ru_media:${draftId}`).row();
  keyboard.text("Publish now", `publish:${draftId}`).text("Schedule", `schedule:${draftId}`).row();
  keyboard.text("Cancel", `cancel:${draftId}`);
  const enabled = TARGETS.filter(([id]) => targets[id]).map(([, label]) => label).join(", ") || "none";
  const schedule = draft.status === "scheduled" ? `\n\nScheduled RU: ${formatMsk(draft.scheduled_at ? String(draft.scheduled_at) : null)}\nScheduled EN: ${formatMsk(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null)}` : "";
  return { text: `Draft #${draftId}\n\nRU:\n${String(draft.text_ru || "[media only]").slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || "[not translated]").slice(0, 1000)}\n\nTargets: ${enabled}${schedule}`, keyboard };
}

function toggleDraftTarget(backendDb: BackendDb, draftId: number, target: string): void {
  const row = backendDb.sqlite.prepare("SELECT targets_json FROM drafts WHERE id=?").get(draftId) as Record<string, unknown> | undefined;
  const targets = parseTargets(row?.targets_json);
  targets[target] = !targets[target];
  backendDb.sqlite.prepare("UPDATE drafts SET targets_json=?, updated_at=? WHERE id=?").run(JSON.stringify(targets), new Date().toISOString(), draftId);
}

function extractMessage(ctx: Context): DraftMessage {
  const message = ctx.message;
  const text = message && "text" in message ? (message.text ?? "") : message && "caption" in message ? (message.caption ?? "") : "";
  const entities = message && "entities" in message ? (message.entities ?? []) : message && "caption_entities" in message ? (message.caption_entities ?? []) : [];
  const media: Record<string, unknown>[] = [];
  const photos = message && "photo" in message ? message.photo : undefined;
  if (photos?.length) {
    const photo = photos[photos.length - 1]!;
    media.push({ type: "photo", file_id: photo.file_id, width: photo.width, height: photo.height });
  }
  if (message && "video" in message && message.video) {
    media.push({ type: "video", file_id: message.video.file_id, width: message.video.width, height: message.video.height, duration: message.video.duration });
  }
  return { text, media, entities };
}

function isAdmin(config: BackendConfig, userId: number | undefined): boolean {
  if (!userId) return false;
  return config.ADMIN_IDS.length === 0 || config.ADMIN_IDS.includes(userId);
}

function parseTargets(value: unknown): Record<string, boolean> {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...DEFAULT_TARGETS };
  }
  return { ...DEFAULT_TARGETS, ...Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, enabled]) => [key, Boolean(enabled)])) };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() || "Alex Getman update";
}

function slugify(text: string, postId: number): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `post-${postId}`;
}

type DraftMessage = {
  text: string;
  textEn?: string;
  media: Record<string, unknown>[];
  entities: unknown[];
};

function requireDraft(backendDb: BackendDb, draftId: number): Record<string, unknown> {
  const draft = backendDb.sqlite.prepare("SELECT * FROM drafts WHERE id=?").get(draftId) as Record<string, unknown> | undefined;
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function getAdminState(backendDb: BackendDb, adminId: number): { action: string | null; draft_id: number | null } | null {
  return backendDb.sqlite.prepare("SELECT action, draft_id FROM admin_state WHERE admin_id=?").get(adminId) as { action: string | null; draft_id: number | null } | null;
}

function setAdminState(backendDb: BackendDb, adminId: number, action: string | null = null, draftId: number | null = null): void {
  backendDb.sqlite.prepare(`INSERT INTO admin_state(admin_id, action, draft_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(admin_id) DO UPDATE SET action=excluded.action, draft_id=excluded.draft_id, updated_at=excluded.updated_at`)
    .run(adminId, action, draftId, new Date().toISOString());
}

async function applyAdminState(ctx: Context, backendDb: BackendDb, action: string, draftId: number): Promise<void> {
  const message = extractMessage(ctx);
  const now = new Date().toISOString();
  if (action.startsWith("schedule_manual_")) {
    const value = parseManualSchedule(message.text);
    const scope = action.slice("schedule_manual_".length);
    const draft = requireDraft(backendDb, draftId);
    const ruAt = scope === "en" ? dateOrNull(draft.scheduled_at) : value;
    const enAt = scope === "ru" ? dateOrNull(draft.scheduled_en_at) : value;
    publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt, enAt });
  } else if (action === "edit_ru" || action === "edit_en") {
    if (!message.text) throw new Error("edited text is empty");
    const column = action === "edit_ru" ? "text_ru" : "text_en_approved";
    const entitiesColumn = action === "edit_ru" ? "text_ru_entities_json" : "text_en_entities_json";
    backendDb.sqlite.prepare(`UPDATE drafts SET ${column}=?, ${entitiesColumn}=?, updated_at=? WHERE id=?`).run(message.text, JSON.stringify(message.entities), now, draftId);
  } else if (action === "replace_ru_media" || action === "replace_en_media") {
    if (message.media.length === 0) throw new Error("replacement media is empty");
    const column = action === "replace_ru_media" ? "media_ru_json" : "media_en_json";
    backendDb.sqlite.prepare(`UPDATE drafts SET ${column}=?, updated_at=? WHERE id=?`).run(JSON.stringify(message.media), now, draftId);
  }
  setAdminState(backendDb, Number(ctx.from?.id));
  await ctx.reply(`Draft #${draftId} updated.`);
  await sendDraftPreview(ctx, backendDb, draftId);
}

function dateOrNull(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

type PendingAlbumInput = {
  adminId: number;
  chatId: number;
  mediaGroupId: string;
  text: string;
  entities: unknown[];
  media: Record<string, unknown>;
  action: string | null;
  draftId: number | null;
};

function appendPendingAlbum(backendDb: BackendDb, input: PendingAlbumInput): boolean {
  const id = `${input.adminId}:${input.chatId}:${input.mediaGroupId}:${input.action ?? "draft"}:${input.draftId ?? ""}`;
  const row = backendDb.sqlite.prepare("SELECT media_json,text_ru,text_entities_json FROM pending_albums WHERE id=?").get(id) as { media_json?: string; text_ru?: string; text_entities_json?: string } | undefined;
  const media = row ? parseArrayValue(row.media_json) : [];
  media.push(input.media);
  const now = new Date().toISOString();
  backendDb.sqlite.prepare(`INSERT INTO pending_albums(id,admin_id,chat_id,media_group_id,action,draft_id,text_ru,text_entities_json,media_json,notified,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,?)
    ON CONFLICT(id) DO UPDATE SET text_ru=excluded.text_ru,text_entities_json=excluded.text_entities_json,media_json=excluded.media_json,updated_at=excluded.updated_at`)
    .run(id, input.adminId, input.chatId, input.mediaGroupId, input.action, input.draftId, input.text || row?.text_ru || "", JSON.stringify(input.entities.length ? input.entities : parseArrayValue(row?.text_entities_json)), JSON.stringify(media), now);
  return !row;
}

export async function finalizePendingAlbums(bot: Bot | null, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  const cutoff = new Date(Date.now() - config.CONTROLLER_ALBUM_SETTLE_SECONDS * 1000).toISOString();
  const rows = backendDb.sqlite.prepare("SELECT * FROM pending_albums WHERE updated_at<=? ORDER BY updated_at").all(cutoff) as Array<Record<string, unknown>>;
  let completed = 0;
  for (const row of rows) {
    try {
      const media = parseArrayValue(row.media_json);
      const action = String(row.action ?? "");
      const draftId = row.draft_id == null ? null : Number(row.draft_id);
      if (["replace_ru_media", "replace_en_media"].includes(action) && draftId) {
        const column = action === "replace_ru_media" ? "media_ru_json" : "media_en_json";
        backendDb.sqlite.prepare(`UPDATE drafts SET ${column}=?, updated_at=? WHERE id=?`).run(JSON.stringify(media), new Date().toISOString(), draftId);
        setAdminState(backendDb, Number(row.admin_id));
        const preview = draftPreview(backendDb, draftId);
        await bot.api.sendMessage(Number(row.chat_id), preview.text, { reply_markup: preview.keyboard });
      } else {
        const text = String(row.text_ru ?? "");
        let textEn = text;
        try { textEn = await translateToEnglish(text, config); } catch { textEn = ""; }
        const created = createDraftFromMessage(backendDb, Number(row.admin_id), { text, textEn, media, entities: parseArrayValue(row.text_entities_json) });
        const preview = draftPreview(backendDb, created);
        await bot.api.sendMessage(Number(row.chat_id), preview.text, { reply_markup: preview.keyboard });
      }
      backendDb.sqlite.prepare("DELETE FROM pending_albums WHERE id=?").run(String(row.id));
      completed += 1;
    } catch (error) {
      log("error", "album finalization failed", { album: row.id, error: String(error) });
    }
  }
  return completed;
}

function parseArrayValue(value: unknown): Record<string, unknown>[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

export function entitiesToHtml(text: string, entities: Record<string, unknown>[]): string {
  const sorted = [...entities]
    .map((entity) => ({ entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((item) => Number.isInteger(item.offset) && Number.isInteger(item.length) && item.offset >= 0 && item.length > 0)
    .sort((left, right) => right.offset - left.offset || left.length - right.length);
  let value = escapeHtml(text).replace(/\n/g, "<br>");
  // Telegram entity offsets are UTF-16 code-unit offsets, the same indexing model as JavaScript strings.
  for (const { entity, offset, length } of sorted) {
    const start = htmlOffset(text, offset);
    const end = htmlOffset(text, offset + length);
    if (start == null || end == null || start >= end) continue;
    const inner = value.slice(start, end);
    const type = String(entity.type ?? "");
    const wrapped = type === "bold" ? `<strong>${inner}</strong>`
      : type === "italic" ? `<em>${inner}</em>`
        : type === "underline" ? `<u>${inner}</u>`
          : type === "strikethrough" ? `<s>${inner}</s>`
            : type === "spoiler" ? `<span class="spoiler">${inner}</span>`
              : type === "code" ? `<code>${inner}</code>`
                : type === "pre" ? `<pre><code>${inner}</code></pre>`
                  : type === "text_link" && typeof entity.url === "string" ? `<a href="${escapeHtml(entity.url)}" rel="noopener noreferrer">${inner}</a>`
                    : type === "url" ? `<a href="${inner}" rel="noopener noreferrer">${inner}</a>`
                      : inner;
    value = `${value.slice(0, start)}${wrapped}${value.slice(end)}`;
  }
  return value;
}

function htmlOffset(text: string, offset: number): number | null {
  if (offset < 0 || offset > text.length) return null;
  return escapeHtml(text.slice(0, offset)).replace(/\n/g, "<br>").length;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
