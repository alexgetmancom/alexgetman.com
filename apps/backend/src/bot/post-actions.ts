import { InlineKeyboard } from "grammy";
import type { Flow, FlowStep } from "../application/conversation-flow.js";
import type { DraftMessage } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { plural, t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import type { ConversationState } from "./conversation-state.js";
import { clearConversationState, getConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard, resultNavigationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { botLocale } from "./i18n.js";
import { showStoryCardChoice } from "./post-story-cards.js";
import { canEditLocale, type DraftView, modeLabel } from "./preview.js";
import { renderPostProgress } from "./progress.js";
import type {
  action,
  PublicationActionContext,
  PublicationActionDefinition,
  PublicationActionResult,
} from "./publication-action-contract.js";
import { publicationCallback } from "./publication-callback.js";
import { openPublicationFlow } from "./publication-flow.js";
import { publicationCardEffect, publicationRenderers } from "./publication-renderers.js";
import { callbackMessageId } from "./telegram-context.js";

type PostActionArgs = PublicationActionContext;

type PostWizardLocale = "ru" | "en";
export type PostSessionStep = "new_post" | "edit_sources" | "edit_text" | "replace_media" | "schedule_manual" | "schedule_confirm";

export type PostWizardStep =
  | { type: "new_post" }
  | { type: "edit_sources" }
  | { type: "edit_text"; locale: PostWizardLocale }
  | { type: "replace_media"; locale: PostWizardLocale }
  | { type: "schedule_manual"; locale: PostWizardLocale }
  | { type: "schedule_confirm"; locale: PostWizardLocale; value: Date };

export type PostFlowData = Record<string, unknown>;

export type PostFlowInput = {
  backendDb: BackendDb;
  config: BackendConfig;
  actorId: number;
  draftId: number;
  controlMessageId: number | null;
  step: PostWizardStep;
  message: DraftMessage;
};

function postStepData(step: PostWizardStep): Record<string, unknown> {
  if (step.type === "edit_text" || step.type === "replace_media" || step.type === "schedule_manual") return { locale: step.locale };
  if (step.type === "schedule_confirm") return { locale: step.locale, value: step.value.toISOString() };
  return {};
}

const POST_STEPS: Record<string, FlowStep<PostFlowData, PostFlowInput, PublicationEffect>> = {
  new_post: {
    name: "new_post",
    next: () => "completed",
    accept: (input, data) => ({ ...data, input: input.message }),
  },
  edit_sources: { name: "edit_sources", input: "text", next: () => "completed", accept: acceptPostSourceEdit },
  edit_text: { name: "edit_text", input: "text", next: () => "completed", accept: acceptPostTextEdit },
  replace_media: { name: "replace_media", input: "media", next: () => "completed", accept: acceptPostMediaReplacement },
  schedule_manual: { name: "schedule_manual", input: "text", next: () => "schedule_confirm", accept: acceptManualPostSchedule },
  schedule_confirm: { name: "schedule_confirm", next: () => "completed" },
  completed: { name: "completed", next: () => null },
};

/** The complete post workflow, including input effects and transitions. */
export const POST_FLOW: Flow<PostFlowData, PostFlowInput, PublicationEffect> = {
  kind: "post",
  steps: POST_STEPS,
};

export function postStateStep(state: Pick<ConversationState, "step" | "data"> | null): PostWizardStep | null {
  if (!state) return null;
  if (state.step === "new_post") return { type: "new_post" };
  if (state.step === "edit_sources") return { type: "edit_sources" };
  if (state.step === "edit_text") return localeStep("edit_text", state.data.locale);
  if (state.step === "replace_media") return localeStep("replace_media", state.data.locale);
  if (state.step === "schedule_manual") return localeStep("schedule_manual", state.data.locale);
  if (state.step === "schedule_confirm") {
    const locale = parseLocale(state.data.locale);
    const date = parseDate(state.data.value);
    return locale && date ? { type: "schedule_confirm", locale, value: date } : null;
  }
  return null;
}

async function acceptManualPostSchedule(
  input: PostFlowInput,
  data: PostFlowData,
): Promise<{ data: PostFlowData; effects: readonly PublicationEffect[] }> {
  const { step } = input;
  if (step.type !== "schedule_manual") throw new StudioError("action.session-stale");
  const posts = createStudioServices(input.backendDb, input.config).posts;
  const { ruAt, enAt } = posts.manualSchedule(input.actorId, input.draftId, step.locale, input.message.text);
  const value = step.locale === "ru" ? ruAt : enAt;
  if (!value) throw new StudioError("err.no-pub-time");
  return { data: { ...data, locale: step.locale, value: value.toISOString() }, effects: [] };
}

async function acceptPostTextEdit(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
  if (input.step.type !== "edit_text") throw new StudioError("action.session-stale");
  createStudioServices(input.backendDb, input.config).posts.edit(input.actorId, input.draftId, {
    locale: input.step.locale,
    text: input.message.text,
    entities: input.message.entities,
    media: input.message.media,
    clearMedia: isClearMediaCommand(input.message.text),
  });
  return { ...data, input: input.message };
}

async function acceptPostMediaReplacement(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
  if (input.step.type !== "replace_media") throw new StudioError("action.session-stale");
  createStudioServices(input.backendDb, input.config).posts.edit(input.actorId, input.draftId, {
    locale: input.step.locale,
    text: input.message.text,
    entities: input.message.entities,
    media: input.message.media,
    replaceMediaOnly: true,
  });
  return { ...data, input: input.message };
}

async function acceptPostSourceEdit(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
  if (input.step.type !== "edit_sources") throw new StudioError("action.session-stale");
  const urls = extractUrls(input.message.text);
  if (urls.length === 0) throw new StudioError("err.no-valid-source-links");
  createStudioServices(input.backendDb, input.config).posts.replaceSources(input.actorId, input.draftId, urls);
  return { ...data, input: input.message };
}

function localeStep(type: "edit_text" | "replace_media" | "schedule_manual", value: unknown): PostWizardStep | null {
  const locale = parseLocale(value);
  return locale ? { type, locale } : null;
}

function parseLocale(value: unknown): PostWizardLocale | null {
  return value === "ru" || value === "en" ? value : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isClearMediaCommand(text: string): boolean {
  const clean = text.trim().toLowerCase();
  return clean === "/delmedia" || clean === "очистить" || clean === "без медиа" || clean === "clear media";
}

function extractUrls(value: string): string[] {
  return value
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => {
      try {
        const url = new URL(item);
        return url.protocol === "https:" || url.protocol === "http:";
      } catch {
        return false;
      }
    });
}

export function definePostActionHandlers(define: typeof action): Record<string, PublicationActionDefinition> {
  return {
    toggle: define(handleToggle, { entity: "draft", freshCard: true, args: ["target"] }),
    cancel: define(handleCancel, { entity: "draft", freshCard: true, args: ["view"] }),
    cancel_confirm: define(handleCancelConfirm, { entity: "draft", freshCard: true, args: [] }),
    cancel_dialog: define(handleCancelDialog, { entity: "session", sessionRevision: true, args: [] }),
    cycle_mode: define(handleCycleMode, { entity: "draft", freshCard: true, args: [] }),
    edit_menu: define(handleEditMenu, { entity: "draft", freshCard: true, args: [] }),
    edit_ru: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    edit_en: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    edit_media_ru: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    edit_media_en: define(handleEdit, { entity: "draft", freshCard: true, args: [] }),
    sources: define(handleSources, { entity: "draft", freshCard: true, args: [] }),
    schedule: define(handleSchedule, { entity: "draft", freshCard: true, args: [] }),
    sched_scope: define(handleScheduleScope, { entity: "draft", freshCard: true, args: ["scope"] }),
    sched_pick: define(handleSchedulePick, { entity: "draft", freshCard: true, args: ["axis", "clock"] }),
    sched_confirm: define(handleManualScheduleConfirm, { entity: "draft", freshCard: true, sessionRevision: true, args: [] }),
    sched_manual: define(handleManualSchedule, { entity: "draft", freshCard: true, args: ["axis"] }),
    story_publish_all: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    story_publish_site: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    story_schedule_all: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    story_schedule_site: define(handleStoryChoice, { entity: "draft", freshCard: true, args: [] }),
    threads_chain: define(handleThreadsChain, { entity: "draft", freshCard: true, args: [] }),
    publish: define(handlePublish, { entity: "draft", freshCard: true, args: [] }),
    publish_confirm: define(handlePublishConfirm, { entity: "draft", freshCard: true, args: [] }),
  };
}

const POST_INPUT_STEPS: Record<string, PostWizardStep> = {
  edit_ru: { type: "edit_text", locale: "ru" },
  edit_en: { type: "edit_text", locale: "en" },
  edit_media_ru: { type: "replace_media", locale: "ru" },
  edit_media_en: { type: "replace_media", locale: "en" },
};

async function handleCycleMode({
  backendDb,
  config,
  actorId,
  locale,
  draftId,
  services,
}: PostActionArgs): Promise<PublicationActionResult> {
  const posts = services.posts;
  const nextMode = posts.cycleMode(actorId, draftId);
  return previewEffects(backendDb, draftId, config, "overview", `${t(locale, "post.mode")}: ${modeLabel(nextMode, locale)}`);
}

async function handleToggle(args: PostActionArgs): Promise<PublicationActionResult> {
  const target = args.args.target;
  if (!target) throw new StudioError("action.unknown");
  args.pipeline.toggleTarget(args.actorId, args.draftId, target);
  const card = args.renderer.card({
    backendDb: args.backendDb,
    pipeline: args.pipeline,
    actorId: args.actorId,
    publicationId: args.draftId,
    config: args.config,
    locale: args.locale,
    view: "platforms",
  });
  return [{ type: "toast", text: t(args.locale, "action.target-updated", { target }) }, ...publicationCardEffect(card)];
}

async function handleCancel(args: PostActionArgs): Promise<PublicationActionResult> {
  const card = args.renderer.card({
    backendDb: args.backendDb,
    pipeline: args.pipeline,
    actorId: args.actorId,
    publicationId: args.draftId,
    config: args.config,
    locale: args.locale,
    view: args.args.view ?? "confirm_cancel",
  });
  return publicationCardEffect(card);
}

async function handleCancelConfirm(args: PostActionArgs): Promise<PublicationActionResult> {
  args.pipeline.cancel(args.actorId, args.draftId);
  return [
    { type: "toast", text: t(args.locale, "action.cancelled") },
    {
      type: "screen",
      mode: "edit",
      text: t(args.locale, "action.draft-cancelled", { id: args.draftId }),
      options: { reply_markup: resultNavigationKeyboard(args.locale, "drafts") },
    },
  ];
}

async function handleCancelDialog(args: PostActionArgs): Promise<PublicationActionResult> {
  return [
    { type: "answer-callback" },
    { type: "session", operation: "clear", kind: args.callback.kind, actorId: args.actorId },
    ...(args.mainMenu ? [{ type: "main-menu", menu: args.mainMenu, edit: true } as const] : []),
  ];
}

async function handleEdit({ ctx, backendDb, actorId, locale, action, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  if (!draftId) throw new StudioError("action.invalid-post");
  const step = POST_INPUT_STEPS[action];
  if (!step) throw new StudioError("action.session-stale");
  openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId,
    step: step.type,
    data: postStepData(step),
    controlMessageId: callbackMessageId(ctx),
  });
  return [
    { type: "toast", text: t(locale, "action.send-replacement") },
    promptEffect(
      backendDb,
      actorId,
      draftId,
      step.type === "replace_media" ? t(locale, "action.send-new-media") : t(locale, "action.send-new-text"),
    ),
  ];
}

async function handleEditMenu({ backendDb, config, actorId, locale, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  const keyboard = new InlineKeyboard();
  const addLocale = (targetLocale: "ru" | "en"): void => {
    if (!canEditLocale(backendDb, config, actorId, draftId, targetLocale)) return;
    if (targetLocale === "ru")
      keyboard
        .text(t(locale, "post.edit-ru"), publicationCallback("post", "edit_ru", [draftId]))
        .text(t(locale, "post.edit-media-ru"), publicationCallback("post", "edit_media_ru", [draftId]))
        .row();
    else
      keyboard
        .text(t(locale, "post.edit-en"), publicationCallback("post", "edit_en", [draftId]))
        .text(t(locale, "post.edit-media-en"), publicationCallback("post", "edit_media_en", [draftId]))
        .row();
  };
  addLocale("ru");
  addLocale("en");
  keyboard.text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"]));
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, "post.what-to-edit"),
      options: { parse_mode: "Markdown", reply_markup: keyboard },
      card: { kind: "post", draftId },
    },
  ];
}

async function handleSources({ ctx, backendDb, actorId, locale, draftId }: PostActionArgs): Promise<PublicationActionResult> {
  openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId,
    step: "edit_sources",
    data: {},
    controlMessageId: callbackMessageId(ctx),
  });
  return [{ type: "answer-callback" }, promptEffect(backendDb, actorId, draftId, t(locale, "post.sources-prompt"))];
}

async function handlePublish(args: PostActionArgs): Promise<PublicationActionResult> {
  return showPublicationIntent(args, "publish");
}

async function handlePublishConfirm(args: PostActionArgs): Promise<PublicationActionResult> {
  return queuePostNow(args);
}

async function handleStoryChoice(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, config, actorId, action, draftId, services } = args;
  const posts = services.posts;
  posts.setStoryPublishMode(actorId, draftId, action.endsWith("_all") ? "all" : "site_only");
  return action.startsWith("story_publish_") ? queuePostNow(args) : previewEffects(backendDb, draftId, config, "schedule");
}

async function handleThreadsChain(args: PostActionArgs): Promise<PublicationActionResult> {
  const { ctx, backendDb, config, actorId, locale, draftId, services } = args;
  const posts = services.posts;
  posts.approveThreadsChain(actorId, draftId);
  // The waiver only clears the Threads rule. Other preflight issues remain fatal.
  const preflight = await showPublicationPreflight(args);
  if (preflight) return preflight;
  const storyChoice = await showStoryCardChoice(ctx, backendDb, config, actorId, draftId, "publish");
  if (storyChoice) return storyChoice;
  return [{ type: "toast", text: t(locale, "action.preflight-chain-approved") }, ...sendPublishConfirmation(args)];
}

async function handleSchedule(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId } = args;
  clearConversationState(backendDb, actorId, "post");
  return showPublicationIntent(args, "schedule");
}

async function showPublicationIntent(args: PostActionArgs, intent: "publish" | "schedule"): Promise<PublicationActionResult> {
  const { backendDb, config, actorId, draftId } = args;
  const preflight = await showPublicationPreflight(args);
  if (preflight) return preflight;
  const storyChoice = await showStoryCardChoice(args.ctx, backendDb, config, actorId, draftId, intent);
  if (storyChoice) return storyChoice;
  return intent === "publish" ? sendPublishConfirmation(args) : previewEffects(backendDb, draftId, config, "schedule");
}

async function handleScheduleScope(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, config, actorId, locale, draftId } = args;
  const scope = args.args.scope;
  if (!scope) return [{ type: "toast", text: t(locale, "action.unknown") }];
  clearConversationState(backendDb, actorId, "post");
  if (scope === "ru_now") return commitLocaleSchedule(args, "ru", new Date(), "ru");
  if (scope === "en_now") return commitLocaleSchedule(args, "en", new Date(), "en");
  if (scope === "both") return previewEffects(backendDb, draftId, config, "schedule_ru");
  return [{ type: "toast", text: t(locale, "action.unknown") }];
}

async function handleSchedulePick(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId, pipeline } = args;
  const axis = args.args.axis;
  const clock = args.args.clock;
  if (!axis || !clock) return;
  if (pipeline.capabilities.scheduleAxis !== "locale") throw new StudioError("action.schedule-expired");
  clearConversationState(backendDb, actorId, "post");
  const value = pipeline.slotTime(`${clock.slice(0, 2)}:${clock.slice(2, 4)}`);
  return commitLocaleSchedule(args, requireScheduleLocale(axis), value);
}

async function handleManualScheduleConfirm(args: PostActionArgs): Promise<PublicationActionResult> {
  const { backendDb, actorId, locale, draftId } = args;
  const state = getConversationState(backendDb, actorId, "post");
  const stateStep = postStateStep(state);
  if (stateStep?.type !== "schedule_confirm" || state?.draftId !== draftId)
    return [{ type: "toast", text: t(locale, "action.schedule-expired") }];
  const { locale: scope, value } = stateStep;
  clearConversationState(backendDb, actorId, "post");
  return commitLocaleSchedule(args, scope, value);
}

async function handleManualSchedule(args: PostActionArgs): Promise<PublicationActionResult> {
  const { ctx, backendDb, actorId, locale, draftId, config } = args;
  const axis = args.args.axis;
  if (!axis) return;
  const pickLocale = requireScheduleLocale(axis);
  clearConversationState(backendDb, actorId, "post");
  openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId,
    step: "schedule_manual",
    data: { locale: pickLocale },
    controlMessageId: callbackMessageId(ctx),
  });
  return [
    { type: "toast", text: t(locale, "action.send-time") },
    promptEffect(
      backendDb,
      actorId,
      draftId,
      t(locale, "action.enter-datetime", { timezone: config.TIMEZONE_LABEL }),
      pickLocale === "ru" ? "schedule_ru" : "schedule_en",
    ),
  ];
}

async function queuePostNow(args: PostActionArgs): Promise<PublicationActionResult> {
  const { services, actorId, draftId, locale } = args;
  const posts = services.posts;
  posts.publish(actorId, draftId);
  const progress = renderPostProgress(posts.progress(actorId, draftId), locale);
  return [
    { type: "toast", text: t(locale, "action.queued") },
    { type: "screen", mode: "edit", text: t(locale, "action.post-queued", { id: draftId }) },
    {
      type: "prompt",
      text: progress.text,
      options: { parse_mode: "Markdown", reply_markup: progress.keyboard },
      card: { kind: "post-progress", draftId },
    },
  ];
}

/** Commits one locale's schedule immediately (button/auto pick, or "now"). If
 * the other locale still needs a time and has enabled targets, hands off to
 * its slot screen instead of finishing; otherwise shows the final result. */
async function commitLocaleSchedule(
  args: PostActionArgs,
  scheduleLocale: "ru" | "en",
  value: Date,
  immediateLocale?: "ru" | "en",
): Promise<PublicationEffect[]> {
  const { services, backendDb, config, actorId, draftId } = args;
  const posts = services.posts;
  const { ruAt, enAt } = posts.scheduleAt(actorId, draftId, scheduleLocale, value);
  posts.schedule(actorId, draftId, {
    ruAt,
    enAt,
    ...(immediateLocale ? { immediateLocale } : {}),
  });
  const otherLocale = scheduleLocale === "ru" ? "en" : "ru";
  const otherAt = otherLocale === "ru" ? ruAt : enAt;
  const uiLocale = botLocale(backendDb, actorId);
  if (!otherAt && posts.hasLocaleTargets(actorId, draftId, otherLocale)) {
    return previewEffects(backendDb, draftId, config, otherLocale === "ru" ? "schedule_ru" : "schedule_en");
  }
  return [
    { type: "toast", text: t(uiLocale, "common.scheduled") },
    ...publicationCardEffect(
      args.renderer.card({
        backendDb,
        pipeline: posts,
        actorId,
        publicationId: draftId,
        config,
        locale: uiLocale,
        view: "overview",
      }),
    ),
  ];
}

function sendPublishConfirmation(args: PostActionArgs): PublicationEffect[] {
  const { services, backendDb, config, actorId, draftId } = args;
  const delivery = services.posts.preview(actorId, draftId).delivery;
  const card = args.renderer.card({
    backendDb,
    pipeline: services.posts,
    actorId,
    publicationId: draftId,
    config,
    locale: botLocale(backendDb, actorId),
    view: "confirm_publish",
  });
  return [
    { type: "delivery-previews", projections: delivery.projections, locale: botLocale(backendDb, actorId) },
    ...publicationCardEffect(card, { type: "prompt" }),
  ];
}

async function showPublicationPreflight(args: PostActionArgs): Promise<PublicationEffect[] | null> {
  const { services, backendDb, actorId, draftId, locale } = args;
  const issues = services.posts.validate(actorId, draftId);
  const issue = issues[0];
  if (!issue) return null;
  // A waivable issue needs a message, not an alert: an alert cannot carry a
  // button, and the whole point is to offer the chain right where it is refused.
  // Only offer it when every issue is waivable — a Telegram caption stays fatal.
  const parts = issues.every((item) => item.chainParts) ? Math.max(...issues.map((item) => item.chainParts ?? 0)) : 0;
  if (parts > 1) {
    const label = plural(locale, parts, {
      one: t(locale, "action.parts-one"),
      few: t(locale, "action.parts-few"),
      many: t(locale, "action.parts-many"),
    });
    const revision = getConversationState(backendDb, actorId, "post")?.revision;
    return [
      { type: "answer-callback" },
      {
        type: "prompt",
        text: t(locale, "action.preflight-chain", { label: issue.label, actual: issue.actual, limit: issue.limit, parts: label }),
        options: {
          reply_markup: new InlineKeyboard().text(
            t(locale, "action.preflight-chain-button", { parts: label }),
            publicationCallback("post", "threads_chain", [draftId], revision),
          ),
        },
        card: { kind: "post", draftId },
      },
    ];
  }
  return [
    {
      type: "toast",
      text: t(locale, "action.preflight", { label: issue.label, actual: issue.actual, limit: issue.limit }),
      showAlert: true,
    },
  ];
}

function previewEffects(
  backendDb: BackendDb,
  draftId: number,
  config: BackendConfig,
  view: DraftView = "overview",
  callbackText?: string,
): PublicationEffect[] {
  const card = publicationRenderers(backendDb, config).post.card({
    backendDb,
    pipeline: createStudioServices(backendDb, config).posts,
    actorId: 0,
    publicationId: draftId,
    config,
    locale: botLocale(backendDb, 0),
    view,
  });
  return [{ type: "answer-callback", ...(callbackText ? { text: callbackText } : {}) }, ...publicationCardEffect(card)];
}

function promptEffect(
  backendDb: BackendDb,
  actorId: number,
  draftId: number,
  text: string,
  returnView: DraftView = "overview",
): PublicationEffect {
  const locale = botLocale(backendDb, actorId);
  const revision = getConversationState(backendDb, actorId, "post")?.revision;
  return {
    type: "prompt",
    text,
    options: {
      parse_mode: "Markdown",
      reply_markup: cancelPromptKeyboard(locale, publicationCallback("post", "cancel_dialog", [], revision)),
    },
  };
}

function requireScheduleLocale(value: string): "ru" | "en" {
  if (value === "ru" || value === "en") return value;
  throw new StudioError("err.unknown-scope");
}
