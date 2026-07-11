import { and, asc, count, eq, inArray, lte, sql } from "drizzle-orm";
import { Bot, type Context, InlineKeyboard } from "grammy";
import { DEFAULT_TARGETS, isSiteTarget, PRESETS, TARGETS, targetLocale } from "./botTargets.js";
import type { BackendConfig } from "./config.js";
import type { BackendDb } from "./db/client.js";
import {
  adminState,
  drafts,
  pendingAlbums,
  postLocales,
  posts,
  publicationPlans,
  publicationSources,
  publications,
  publishJobs,
  siteJobs,
  siteSourceItems,
} from "./db/schema.js";
import { log } from "./logger.js";
import { generateStoryMedia } from "./media/story.js";
import { localizeTargetPayload } from "./publicationPayload.js";
import { formatMsk, nextPublishingSlot, parseManualSchedule, rebalanceScheduledDrafts, schedulePreset } from "./publishingSchedule.js";
import { enqueuePublishJob } from "./queue/publish.js";
import { translateToEnglish } from "./translation.js";

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

function bindBotHandlers(bot: Bot, config: BackendConfig, backendDb: BackendDb): void {
  bot.command("start", (ctx) => ctx.reply("Send draft text with optional photo/video. Use Publish after preview."));
  bot.command("pipeline_status", (ctx) => ctx.reply(`${config.COMMAND_CENTER_URL.replace(/\/$/, "")}/pipeline-status`));
  bot.command("schedule", async (ctx) => {
    if (!isAdmin(config, ctx.from?.id)) {
      await ctx.reply("Forbidden");
      return;
    }
    const drafts = scheduledDrafts(backendDb);
    if (drafts.length === 0) {
      await ctx.reply("No scheduled drafts.");
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const draft of drafts)
      keyboard.text(`#${draft.id} ${formatMsk(draft.scheduledAt)} / ${formatMsk(draft.scheduledEnAt)}`, `schedule:${draft.id}`).row();
    await ctx.reply("Scheduled drafts", { reply_markup: keyboard });
  });
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

async function _processTelegramUpdate(bot: Bot, update: Parameters<Bot["handleUpdate"]>[0]): Promise<void> {
  await bot.handleUpdate(update);
}

export function createDraftFromMessage(backendDb: BackendDb, adminId: number, message: DraftMessage): number {
  const now = new Date().toISOString();
  const targets = { ...DEFAULT_TARGETS };
  return backendDb.db
    .insert(drafts)
    .values({
      adminId,
      status: "needs_review",
      textRu: message.text,
      textEnMachine: message.textEn ?? message.text,
      textEnApproved: message.textEn ?? message.text,
      targetsJson: JSON.stringify(targets),
      mediaRuJson: message.media.length ? JSON.stringify(message.media) : null,
      textRuEntitiesJson: JSON.stringify(message.entities),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: drafts.id })
    .get()!.id;
}

export function scheduledDrafts(backendDb: BackendDb): Array<{ id: number; scheduledAt: string | null; scheduledEnAt: string | null }> {
  return backendDb.db
    .select({ id: drafts.id, scheduledAt: drafts.scheduledAt, scheduledEnAt: drafts.scheduledEnAt })
    .from(drafts)
    .where(eq(drafts.status, "scheduled"))
    .orderBy(asc(sql`coalesce(${drafts.scheduledAt}, ${drafts.scheduledEnAt})`), asc(drafts.id))
    .all();
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
    backendDb.db
      .update(drafts)
      .set({ targetsJson: JSON.stringify(PRESETS[first]), updatedAt: new Date().toISOString() })
      .where(eq(drafts.id, draftId))
      .run();
    await ctx.answerCallbackQuery({ text: `${first} preset` });
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "edit_ru" || action === "edit_en" || action === "replace_ru_media" || action === "replace_en_media") {
    setAdminState(backendDb, Number(ctx.from?.id), action, draftId);
    await ctx.answerCallbackQuery({ text: "Send the replacement as the next message" });
    await ctx.reply(
      action.startsWith("edit") ? "Send edited text as the next message." : "Send replacement photo/video as the next message.",
    );
    return;
  }
  if (action === "use_ru_media") {
    backendDb.db.update(drafts).set({ mediaEnJson: null, updatedAt: new Date().toISOString() }).where(eq(drafts.id, draftId)).run();
    await ctx.answerCallbackQuery({ text: "EN media uses RU fallback" });
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "generate_story_ru" || action === "generate_story_en") {
    const locale = action.endsWith("_ru") ? "ru" : "en";
    const draft = requireDraft(backendDb, draftId);
    const source = locale === "en" ? (parseJson(draft.media_en_json) ?? parseJson(draft.media_ru_json)) : parseJson(draft.media_ru_json);
    const generated = await generateStoryMedia(source, draftId, locale, config);
    if (locale === "en")
      backendDb.db
        .update(drafts)
        .set({ mediaEnJson: JSON.stringify(generated), updatedAt: new Date().toISOString() })
        .where(eq(drafts.id, draftId))
        .run();
    else
      backendDb.db
        .update(drafts)
        .set({ mediaRuJson: JSON.stringify(generated), updatedAt: new Date().toISOString() })
        .where(eq(drafts.id, draftId))
        .run();
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
      .text("Auto next slots", `sched_auto:${draftId}`)
      .text("+30 min", `sched_preset:plus30:${draftId}`)
      .row()
      .text("+1 hour", `sched_preset:plus60:${draftId}`)
      .text("Today 21:00", `sched_preset:today2100:${draftId}`)
      .row()
      .text("Tomorrow 10:00", `sched_preset:tomorrow1000:${draftId}`)
      .row()
      .text("Manual both", `sched_manual:both:${draftId}`)
      .text("Manual RU", `sched_manual:ru:${draftId}`)
      .text("Manual EN", `sched_manual:en:${draftId}`);
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
    rebalanceScheduledDrafts(backendDb);
    await ctx.answerCallbackQuery({ text: "Scheduled" });
    await ctx.reply(`Draft #${draftId} scheduled as post #${postId}.\nRU: ${formatMsk(ruAt)}\nEN: ${formatMsk(enAt)}`);
    await sendDraftPreview(ctx, backendDb, draftId);
    return;
  }
  if (action === "sched_preset" && second) {
    const value = schedulePreset(first!);
    const postId = publishDraftToQueue(backendDb, draftId, { mode: "scheduled", ruAt: value, enAt: value });
    rebalanceScheduledDrafts(backendDb);
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

export function cancelDraft(backendDb: BackendDb, draftId: number): void {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    const publication = tx.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
    const postId = publication?.postId;
    tx.update(drafts)
      .set({ status: "cancelled", scheduledAt: null, scheduledEnAt: null, updatedAt: now })
      .where(eq(drafts.id, draftId))
      .run();
    if (!postId) return;
    const finalCount = tx
      .select({ count: count() })
      .from(publishJobs)
      .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["publishing", "published", "skipped"])))
      .get()!.count;
    if (finalCount > 0) {
      tx.update(publishJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["queued", "failed"])))
        .run();
      tx.update(siteJobs)
        .set({ status: "cancelled", updatedAt: now })
        .where(and(eq(siteJobs.postId, postId), inArray(siteJobs.status, ["queued", "failed"])))
        .run();
      return;
    }
    tx.delete(publishJobs).where(eq(publishJobs.postId, postId)).run();
    tx.delete(siteJobs).where(eq(siteJobs.postId, postId)).run();
    tx.delete(publicationPlans).where(eq(publicationPlans.postId, postId)).run();
    tx.delete(publicationSources).where(eq(publicationSources.postId, postId)).run();
    tx.delete(postLocales).where(eq(postLocales.postId, postId)).run();
    tx.delete(posts).where(eq(posts.postId, postId)).run();
    tx.delete(publications).where(eq(publications.postId, postId)).run();
    tx.update(drafts).set({ postId: null, updatedAt: now }).where(eq(drafts.id, draftId)).run();
  });
  rebalanceScheduledDrafts(backendDb);
}

export function publishDraftToQueue(
  backendDb: BackendDb,
  draftId: number,
  options: { mode?: "immediate" | "scheduled"; ruAt?: Date | null; enAt?: Date | null } = {},
): number {
  const draft = requireDraft(backendDb, draftId);
  const now = new Date().toISOString();
  const mode = options.mode ?? "immediate";
  const ruAt = mode === "immediate" ? now : (options.ruAt?.toISOString() ?? null);
  const enAt = mode === "immediate" ? now : (options.enAt?.toISOString() ?? null);
  const existing = backendDb.db.select({ postId: publications.postId }).from(publications).where(eq(publications.draftId, draftId)).get();
  const postId =
    existing?.postId ??
    backendDb.db
      .insert(publications)
      .values({ status: mode === "immediate" ? "published" : "scheduled", draftId, createdAt: now, updatedAt: now })
      .returning({ postId: publications.postId })
      .get()!.postId;
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
  const ruLocale: typeof postLocales.$inferInsert = {
    postId,
    locale: "ru",
    slug: slugRu,
    text: textRu,
    html: entitiesToHtml(textRu, entitiesRu),
    entitiesJson: typeof draft.text_ru_entities_json === "string" ? draft.text_ru_entities_json : null,
    mediaJson: JSON.stringify(mediaRu ?? []),
    siteEnabled: targets.site_ru ? 1 : 0,
    publishedAt: targets.site_ru ? ruAt : null,
    updatedAt: now,
  };
  const enLocale: typeof postLocales.$inferInsert = {
    postId,
    locale: "en",
    slug: slugEn,
    text: textEn,
    html: entitiesToHtml(textEn, entitiesEn),
    entitiesJson: typeof draft.text_en_entities_json === "string" ? draft.text_en_entities_json : null,
    mediaJson: JSON.stringify(mediaEn ?? []),
    siteEnabled: targets.site_en ? 1 : 0,
    publishedAt: targets.site_en ? enAt : null,
    updatedAt: now,
  };
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

  backendDb.db.transaction((tx) => {
    tx.insert(posts)
      .values({
        postKey,
        postId,
        source: "bot",
        channel: "controller",
        messageId,
        dateUtc: ruAt ?? enAt ?? now,
        text: payload.text,
        textEn: payload.text_en,
        mediaJson: JSON.stringify(mediaRu ?? []),
        mediaCount: Array.isArray(mediaRu) ? mediaRu.length : 0,
        createdAt: now,
        updatedAt: now,
        rawJson: JSON.stringify(payload),
      })
      .onConflictDoUpdate({
        target: posts.postKey,
        set: {
          postId,
          dateUtc: ruAt ?? enAt ?? now,
          text: payload.text,
          textEn: payload.text_en,
          mediaJson: JSON.stringify(mediaRu ?? []),
          mediaCount: Array.isArray(mediaRu) ? mediaRu.length : 0,
          updatedAt: now,
          rawJson: JSON.stringify(payload),
        },
      })
      .run();
    tx.insert(postLocales)
      .values(ruLocale)
      .onConflictDoUpdate({
        target: [postLocales.postId, postLocales.locale],
        set: {
          slug: ruLocale.slug,
          text: ruLocale.text,
          html: ruLocale.html,
          entitiesJson: ruLocale.entitiesJson,
          mediaJson: ruLocale.mediaJson,
          siteEnabled: ruLocale.siteEnabled,
          publishedAt: ruLocale.publishedAt,
          updatedAt: now,
        },
      })
      .run();
    tx.insert(postLocales)
      .values(enLocale)
      .onConflictDoUpdate({
        target: [postLocales.postId, postLocales.locale],
        set: {
          slug: enLocale.slug,
          text: enLocale.text,
          html: enLocale.html,
          entitiesJson: enLocale.entitiesJson,
          mediaJson: enLocale.mediaJson,
          siteEnabled: enLocale.siteEnabled,
          publishedAt: enLocale.publishedAt,
          updatedAt: now,
        },
      })
      .run();
    tx.insert(publicationPlans)
      .values({
        postId,
        planJson: JSON.stringify({ draft_id: draftId, targets, scheduled_at: ruAt, scheduled_en_at: enAt, created_at: now }),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: publicationPlans.postId,
        set: {
          planJson: JSON.stringify({ draft_id: draftId, targets, scheduled_at: ruAt, scheduled_en_at: enAt, created_at: now }),
          updatedAt: now,
        },
      })
      .run();
    tx.insert(publicationSources)
      .values({ postId, itemJson: JSON.stringify(payload), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: publicationSources.postId, set: { itemJson: JSON.stringify(payload), updatedAt: now } })
      .run();
    tx.insert(siteSourceItems)
      .values({ messageId, itemJson: JSON.stringify(payload), createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: siteSourceItems.messageId, set: { itemJson: JSON.stringify(payload), updatedAt: now } })
      .run();
    tx.delete(publishJobs)
      .where(and(eq(publishJobs.postId, postId), inArray(publishJobs.status, ["queued", "failed"])))
      .run();
    tx.delete(siteJobs)
      .where(and(eq(siteJobs.postId, postId), inArray(siteJobs.status, ["queued", "failed"])))
      .run();
    for (const [target, enabled] of Object.entries(targets)) {
      if (!enabled || isSiteTarget(target)) continue;
      const publishAt = targetLocale(target) === "en" ? enAt : ruAt;
      enqueuePublishJob(backendDb, { postId, postKey, messageId, target, payload: localizeTargetPayload(payload, target), publishAt });
    }
    for (const [locale, enabled, publishAt] of [
      ["ru", targets.site_ru, ruAt],
      ["en", targets.site_en, enAt],
    ] as const) {
      if (enabled && publishAt)
        tx.insert(siteJobs)
          .values({
            postId,
            messageId,
            reason: `publish_${locale}`,
            status: "queued",
            nextAttemptAt: publishAt,
            createdAt: now,
            updatedAt: now,
          })
          .run();
    }
    tx.update(drafts)
      .set({
        status: mode === "immediate" ? "published" : "scheduled",
        postId,
        publishMode: mode,
        scheduledAt: ruAt,
        scheduledEnAt: enAt,
        updatedAt: now,
      })
      .where(eq(drafts.id, draftId))
      .run();
    tx.update(publications)
      .set({ status: mode === "immediate" ? "published" : "scheduled", updatedAt: now })
      .where(eq(publications.postId, postId))
      .run();
  });
  return postId;
}

async function sendDraftPreview(ctx: Context, backendDb: BackendDb, draftId: number): Promise<void> {
  const preview = draftPreview(backendDb, draftId);
  await ctx.reply(preview.text, { reply_markup: preview.keyboard });
}

function draftPreview(backendDb: BackendDb, draftId: number): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const targets = parseTargets(draft.targets_json);
  const keyboard = new InlineKeyboard();
  keyboard
    .text("Full", `preset:full:${draftId}`)
    .text("RU only", `preset:ru:${draftId}`)
    .text("EN only", `preset:en:${draftId}`)
    .text("TG only", `preset:tg:${draftId}`)
    .row();
  for (let index = 0; index < TARGETS.length; index += 2) {
    for (const [target, label] of TARGETS.slice(index, index + 2))
      keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
    keyboard.row();
  }
  keyboard.text("Edit RU", `edit_ru:${draftId}`).text("Edit EN", `edit_en:${draftId}`).row();
  keyboard.text("Replace RU media", `replace_ru_media:${draftId}`).text("Replace EN media", `replace_en_media:${draftId}`).row();
  keyboard.text("Generate RU 9:16", `generate_story_ru:${draftId}`).text("Generate EN 9:16", `generate_story_en:${draftId}`).row();
  keyboard.text("Use RU media for EN", `use_ru_media:${draftId}`).row();
  keyboard.text("Publish now", `publish:${draftId}`).text("Schedule", `schedule:${draftId}`).row();
  keyboard.text("Cancel", `cancel:${draftId}`);
  const enabled =
    TARGETS.filter(([id]) => targets[id])
      .map(([, label]) => label)
      .join(", ") || "none";
  const schedule =
    draft.status === "scheduled"
      ? `\n\nScheduled RU: ${formatMsk(draft.scheduled_at ? String(draft.scheduled_at) : null)}\nScheduled EN: ${formatMsk(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null)}`
      : "";
  return {
    text: `Draft #${draftId}\n\nRU:\n${String(draft.text_ru || "[media only]").slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || "[not translated]").slice(0, 1000)}\n\nTargets: ${enabled}${schedule}`,
    keyboard,
  };
}

function toggleDraftTarget(backendDb: BackendDb, draftId: number, target: string): void {
  const row = backendDb.db.select({ targetsJson: drafts.targetsJson }).from(drafts).where(eq(drafts.id, draftId)).get();
  const targets = parseTargets(row?.targetsJson);
  targets[target] = !targets[target];
  backendDb.db
    .update(drafts)
    .set({ targetsJson: JSON.stringify(targets), updatedAt: new Date().toISOString() })
    .where(eq(drafts.id, draftId))
    .run();
}

function extractMessage(ctx: Context): DraftMessage {
  const message = ctx.message;
  const text = message && "text" in message ? (message.text ?? "") : message && "caption" in message ? (message.caption ?? "") : "";
  const entities =
    message && "entities" in message
      ? (message.entities ?? [])
      : message && "caption_entities" in message
        ? (message.caption_entities ?? [])
        : [];
  const media: Record<string, unknown>[] = [];
  const photos = message && "photo" in message ? message.photo : undefined;
  if (photos?.length) {
    const photo = photos[photos.length - 1]!;
    media.push({ type: "photo", file_id: photo.file_id, width: photo.width, height: photo.height });
  }
  if (message && "video" in message && message.video) {
    media.push({
      type: "video",
      file_id: message.video.file_id,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
    });
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
  return {
    ...DEFAULT_TARGETS,
    ...Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([key, enabled]) => [key, Boolean(enabled)])),
  };
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
  const draft = backendDb.db
    .select({
      id: drafts.id,
      status: drafts.status,
      text_ru: drafts.textRu,
      text_en_machine: drafts.textEnMachine,
      text_en_approved: drafts.textEnApproved,
      targets_json: drafts.targetsJson,
      media_ru_json: drafts.mediaRuJson,
      media_en_json: drafts.mediaEnJson,
      channel_message_id: drafts.channelMessageId,
      scheduled_at: drafts.scheduledAt,
      scheduled_en_at: drafts.scheduledEnAt,
      text_ru_entities_json: drafts.textRuEntitiesJson,
      text_en_entities_json: drafts.textEnEntitiesJson,
    })
    .from(drafts)
    .where(eq(drafts.id, draftId))
    .get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  return draft;
}

function hasLocaleTarget(targets: Record<string, boolean>, locale: "ru" | "en"): boolean {
  return Object.entries(targets).some(([target, enabled]) => enabled && targetLocale(target) === locale);
}

function getAdminState(backendDb: BackendDb, adminId: number): { action: string | null; draft_id: number | null } | null {
  return (
    backendDb.db
      .select({ action: adminState.action, draft_id: adminState.draftId })
      .from(adminState)
      .where(eq(adminState.adminId, adminId))
      .get() ?? null
  );
}

function setAdminState(backendDb: BackendDb, adminId: number, action: string | null = null, draftId: number | null = null): void {
  backendDb.db
    .insert(adminState)
    .values({ adminId, action, draftId, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: adminState.adminId, set: { action, draftId, updatedAt: new Date().toISOString() } })
    .run();
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
    rebalanceScheduledDrafts(backendDb);
  } else if (action === "edit_ru" || action === "edit_en") {
    if (!message.text) throw new Error("edited text is empty");
    if (action === "edit_ru")
      backendDb.db
        .update(drafts)
        .set({ textRu: message.text, textRuEntitiesJson: JSON.stringify(message.entities), updatedAt: now })
        .where(eq(drafts.id, draftId))
        .run();
    else
      backendDb.db
        .update(drafts)
        .set({ textEnApproved: message.text, textEnEntitiesJson: JSON.stringify(message.entities), updatedAt: now })
        .where(eq(drafts.id, draftId))
        .run();
  } else if (action === "replace_ru_media" || action === "replace_en_media") {
    if (message.media.length === 0) throw new Error("replacement media is empty");
    if (action === "replace_ru_media")
      backendDb.db
        .update(drafts)
        .set({ mediaRuJson: JSON.stringify(message.media), updatedAt: now })
        .where(eq(drafts.id, draftId))
        .run();
    else
      backendDb.db
        .update(drafts)
        .set({ mediaEnJson: JSON.stringify(message.media), updatedAt: now })
        .where(eq(drafts.id, draftId))
        .run();
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
  const row = backendDb.db
    .select({ media_json: pendingAlbums.mediaJson, text_ru: pendingAlbums.textRu, text_entities_json: pendingAlbums.textEntitiesJson })
    .from(pendingAlbums)
    .where(eq(pendingAlbums.id, id))
    .get();
  const media = row ? parseArrayValue(row.media_json) : [];
  media.push(input.media);
  const now = new Date().toISOString();
  const values = {
    id,
    adminId: input.adminId,
    chatId: input.chatId,
    mediaGroupId: input.mediaGroupId,
    action: input.action,
    draftId: input.draftId,
    textRu: input.text || row?.text_ru || "",
    textEntitiesJson: JSON.stringify(input.entities.length ? input.entities : parseArrayValue(row?.text_entities_json)),
    mediaJson: JSON.stringify(media),
    notified: 1,
    updatedAt: now,
  };
  backendDb.db
    .insert(pendingAlbums)
    .values(values)
    .onConflictDoUpdate({
      target: pendingAlbums.id,
      set: { textRu: values.textRu, textEntitiesJson: values.textEntitiesJson, mediaJson: values.mediaJson, updatedAt: now },
    })
    .run();
  return !row;
}

export async function finalizePendingAlbums(bot: Bot | null, backendDb: BackendDb, config: BackendConfig): Promise<number> {
  if (!bot) return 0;
  const cutoff = new Date(Date.now() - config.CONTROLLER_ALBUM_SETTLE_SECONDS * 1000).toISOString();
  const rows = backendDb.db
    .select({
      id: pendingAlbums.id,
      admin_id: pendingAlbums.adminId,
      chat_id: pendingAlbums.chatId,
      action: pendingAlbums.action,
      draft_id: pendingAlbums.draftId,
      text_ru: pendingAlbums.textRu,
      text_entities_json: pendingAlbums.textEntitiesJson,
      media_json: pendingAlbums.mediaJson,
    })
    .from(pendingAlbums)
    .where(lte(pendingAlbums.updatedAt, cutoff))
    .orderBy(asc(pendingAlbums.updatedAt))
    .all();
  let completed = 0;
  for (const row of rows) {
    try {
      const media = parseArrayValue(row.media_json);
      const action = String(row.action ?? "");
      const draftId = row.draft_id == null ? null : Number(row.draft_id);
      if (["replace_ru_media", "replace_en_media"].includes(action) && draftId) {
        if (action === "replace_ru_media")
          backendDb.db
            .update(drafts)
            .set({ mediaRuJson: JSON.stringify(media), updatedAt: new Date().toISOString() })
            .where(eq(drafts.id, draftId))
            .run();
        else
          backendDb.db
            .update(drafts)
            .set({ mediaEnJson: JSON.stringify(media), updatedAt: new Date().toISOString() })
            .where(eq(drafts.id, draftId))
            .run();
        setAdminState(backendDb, Number(row.admin_id));
        const preview = draftPreview(backendDb, draftId);
        await bot.api.sendMessage(Number(row.chat_id), preview.text, { reply_markup: preview.keyboard });
      } else {
        const text = String(row.text_ru ?? "");
        let textEn = text;
        try {
          textEn = await translateToEnglish(text, config);
        } catch {
          textEn = "";
        }
        const created = createDraftFromMessage(backendDb, Number(row.admin_id), {
          text,
          textEn,
          media,
          entities: parseArrayValue(row.text_entities_json),
        });
        const preview = draftPreview(backendDb, created);
        await bot.api.sendMessage(Number(row.chat_id), preview.text, { reply_markup: preview.keyboard });
      }
      backendDb.db.delete(pendingAlbums).where(eq(pendingAlbums.id, row.id)).run();
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
    const wrapped =
      type === "bold"
        ? `<strong>${inner}</strong>`
        : type === "italic"
          ? `<em>${inner}</em>`
          : type === "underline"
            ? `<u>${inner}</u>`
            : type === "strikethrough"
              ? `<s>${inner}</s>`
              : type === "spoiler"
                ? `<span class="spoiler">${inner}</span>`
                : type === "code"
                  ? `<code>${inner}</code>`
                  : type === "pre"
                    ? `<pre><code>${inner}</code></pre>`
                    : type === "text_link" && typeof entity.url === "string"
                      ? `<a href="${escapeHtml(entity.url)}" rel="noopener noreferrer">${inner}</a>`
                      : type === "url"
                        ? `<a href="${inner}" rel="noopener noreferrer">${inner}</a>`
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
