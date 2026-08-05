import type { Context } from "grammy";
import { acceptFlow } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { createStudioServices } from "../studio/services/index.js";
import { requireConversationState, saveConversationState } from "./conversation-state.js";
import { confirmationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { botLocale } from "./i18n.js";
import { extractMessage } from "./message.js";
import type { PostFlowData, PostFlowInput } from "./post-flow-types.js";
import { POST_FLOW, type PostWizardStep } from "./post-fsm.js";
import { renderPublicationCard } from "./publication-card.js";
import { publicationCardEffect } from "./publication-card-effects.js";
import { createPublicationScheduleEngine } from "./scheduling.js";
import { publicationCallback, versionedCallback } from "./session-fsm.js";

export async function applyAdminState(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  step: PostWizardStep,
  draftId: number,
  controlMessageId: number | null,
  expectedRevision?: number | null,
): Promise<PublicationEffect[]> {
  const actorId = Number(ctx.from?.id);
  if (expectedRevision != null) requireConversationState(backendDb, actorId, "post", expectedRevision);
  const message = extractMessage(ctx);
  const transition = await acceptFlow(POST_FLOW, step.type, { backendDb, config, actorId, draftId, controlMessageId, step, message }, {});
  if (!transition) throw new StudioError("action.session-stale");
  if (transition.next === null) {
    const preview = renderPublicationCard("post", { backendDb, config, publicationId: draftId });
    return [
      ...transition.effects,
      { type: "session", operation: "clear", kind: "post", actorId },
      ...publicationCardEffect("post", draftId, preview, { type: "prompt" }),
    ];
  }
  return [...transition.effects];
}

/** Accepts a manually entered publication time and opens the confirmation step. */
export async function acceptManualPostSchedule(
  input: PostFlowInput,
  data: PostFlowData,
): Promise<{ data: PostFlowData; effects: readonly PublicationEffect[] }> {
  const { step } = input;
  if (step.type !== "schedule_manual") throw new StudioError("action.session-stale");
  const { ruAt, enAt } = createStudioServices(input.backendDb, input.config).posts.manualSchedule(
    input.actorId,
    input.draftId,
    step.locale,
    input.message.text,
  );
  const value = step.locale === "ru" ? ruAt : enAt;
  if (!value) throw new StudioError("err.no-pub-time");
  const saved = saveConversationState(input.backendDb, input.actorId, {
    kind: "post",
    draftId: input.draftId,
    step: "schedule_confirm",
    data: { locale: step.locale, value: value.toISOString() },
    controlMessageId: input.controlMessageId,
  });
  const locale = botLocale(input.backendDb, input.actorId);
  const preview = renderPublicationCard("post", {
    backendDb: input.backendDb,
    config: input.config,
    publicationId: input.draftId,
  });
  const scheduleEngine = createPublicationScheduleEngine({
    kind: "post",
    publicationId: input.draftId,
    scheduleAxis: "locale",
    axisKeys: [step.locale],
    axisLabel: (key) => key.toUpperCase(),
    slotValues: [],
  });
  const keyboard = confirmationKeyboard(
    {
      label: t(locale, "post.confirm-schedule-btn"),
      callback: versionedCallback(scheduleEngine.confirmCallback(), saved.revision),
    },
    {
      label: t(locale, "common.back"),
      callback: publicationCallback("post", "sched_view", [input.draftId, step.locale === "ru" ? "schedule_ru" : "schedule_en"]),
    },
  );
  const text = `${preview.text}\n\n📅 *${t(locale, "common.confirm-schedule")}*\nRU: ${formatMsk(ruAt, input.config)}\nEN: ${formatMsk(enAt, input.config)}`;
  const effects: PublicationEffect[] = [
    {
      type: "delivery-previews",
      projections: createStudioServices(input.backendDb, input.config).posts.preview(input.actorId, input.draftId).delivery.projections,
      locale,
    },
    { type: "prompt", text, options: { parse_mode: "Markdown", reply_markup: keyboard }, card: { kind: "post", draftId: input.draftId } },
  ];
  return { data: { ...data, value }, effects };
}

/** Applies a replacement text through the canonical post service. */
export async function acceptPostTextEdit(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
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

/** Applies a media-only replacement through the canonical post service. */
export async function acceptPostMediaReplacement(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
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

/** Replaces the source links after validating that at least one URL was sent. */
export async function acceptPostSourceEdit(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
  if (input.step.type !== "edit_sources") throw new StudioError("action.session-stale");
  const urls = extractUrls(input.message.text);
  if (urls.length === 0) throw new StudioError("err.no-valid-source-links");
  createStudioServices(input.backendDb, input.config).posts.replaceSources(input.actorId, input.draftId, urls);
  return { ...data, input: input.message };
}

/** Chat-only shorthand for clearing a post's media during a free-text edit reply. */
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
