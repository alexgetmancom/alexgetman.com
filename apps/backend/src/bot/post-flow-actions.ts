import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { createStudioServices } from "../studio/services/index.js";
import { saveConversationState } from "./conversation-state.js";
import { confirmationKeyboard } from "./dialog-ui.js";
import type { PublicationEffect } from "./effects.js";
import { botLocale } from "./i18n.js";
import type { PostFlowData, PostFlowInput } from "./post-fsm.js";
import { draftPreview } from "./preview.js";
import { publicationCallback } from "./session-fsm.js";

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
  saveConversationState(input.backendDb, input.actorId, {
    kind: "post",
    draftId: input.draftId,
    step: "schedule_confirm",
    data: { locale: step.locale, value: value.toISOString() },
    controlMessageId: input.controlMessageId,
  });
  const locale = botLocale(input.backendDb, input.actorId);
  const preview = draftPreview(input.backendDb, input.draftId, input.config);
  const keyboard = confirmationKeyboard(
    { label: t(locale, "post.confirm-schedule-btn"), callback: publicationCallback("post", "sched_manual_confirm", [input.draftId]) },
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
