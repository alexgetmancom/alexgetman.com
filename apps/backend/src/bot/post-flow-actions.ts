import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import { createStudioServices } from "../studio/services/index.js";
import { saveConversationState } from "./conversation-state.js";
import { botLocale } from "./i18n.js";
import { showScheduleConfirmation } from "./post-card.js";
import type { PostFlowData, PostFlowInput } from "./post-fsm.js";
import { publicationCallback } from "./session-fsm.js";

/** Accepts a manually entered publication time and opens the confirmation step. */
export async function acceptManualPostSchedule(input: PostFlowInput, data: PostFlowData): Promise<PostFlowData> {
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
  const revision = saveConversationState(input.backendDb, input.actorId, {
    kind: "post",
    draftId: input.draftId,
    step: "schedule_confirm",
    data: { locale: step.locale, value: value.toISOString() },
    controlMessageId: input.controlMessageId,
  }).revision;
  await sendPostPreviews(input.ctx, input.backendDb, input.config, input.actorId, input.draftId);
  await showScheduleConfirmation(
    input.ctx,
    input.backendDb,
    input.draftId,
    input.config,
    ruAt,
    enAt,
    publicationCallback("post", "sched_manual_confirm", [input.draftId], revision),
    step.locale === "ru" ? "schedule_ru" : "schedule_en",
  );
  return { ...data, value };
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

async function sendPostPreviews(
  ctx: PostFlowInput["ctx"],
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
): Promise<void> {
  const delivery = createStudioServices(backendDb, config).posts.preview(actorId, draftId).delivery;
  await sendTelegramDeliveryPreviews(ctx, delivery.projections, botLocale(backendDb, actorId));
}
