import type { Context } from "grammy";
import { flowStepInput } from "../application/conversation-flow.js";
import { translateDraftText } from "../content/translation.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { appendPendingAlbum } from "./albums.js";
import { clearConversationState, getConversationState } from "./conversation-state.js";
import type { PublicationMessageResult } from "./effects.js";
import { persistentKeyboard } from "./menu-render.js";
import { extractMessage } from "./message.js";
import { POST_FLOW, postStateStep } from "./post-flow.js";
import { applyAdminState } from "./post-input-actions.js";
import { postPreviewCard } from "./publication-renderers.js";

/** The conversational text-post screen. It owns operator input from the moment
 * the intake decides the material is a post, and keeps the root bot router
 * limited to authorization and screen dispatch. */
export async function handlePostMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const state = getConversationState(backendDb, actorId, "post");
  const stateStep = postStateStep(state);
  const message = extractMessage(ctx);
  const mediaGroupId = ctx.message && "media_group_id" in ctx.message ? ctx.message.media_group_id : undefined;
  if (mediaGroupId && message.media.length > 0) {
    if (!stateStep || (stateStep.type !== "new_post" && !state?.draftId)) {
      return {
        handled: true,
        effects: [
          {
            type: "screen",
            mode: "reply",
            text: t(locale, "post.album-need-action"),
            options: { reply_markup: persistentKeyboard(locale) },
          },
        ],
      };
    }
    const media = message.media[0];
    if (!media) return { handled: true, effects: [] };
    const isNew = appendPendingAlbum(backendDb, {
      actorId,
      chatId: Number(ctx.chat?.id),
      mediaGroupId,
      text: message.text,
      entities: message.entities,
      media,
      step: stateStep,
      draftId: state?.draftId ?? null,
      stateRevision: state?.revision ?? null,
    });
    return { handled: true, effects: isNew ? [{ type: "screen", mode: "reply", text: t(locale, "post.album-received") }] : [] };
  }
  if (stateStep && flowStepInput(POST_FLOW, stateStep.type) && state?.draftId) {
    try {
      const effects = await applyAdminState(ctx, backendDb, config, stateStep, state.draftId, state.controlMessageId, state.revision);
      return { handled: true, effects };
    } catch (error) {
      const scheduleInput = stateStep.type === "schedule_manual";
      const errorText =
        error instanceof StudioError && error.code === "common.schedule-parse-error"
          ? t(locale, "common.schedule-parse-error", {
              timezone: createStudioServices(backendDb, config).settings.timeConfig(actorId, config).TIMEZONE_LABEL,
            })
          : describeError(locale, error);
      return {
        handled: true,
        effects: [{ type: "screen", mode: "reply", text: scheduleInput ? errorText : t(locale, "post.value-error", { error: errorText }) }],
      };
    }
  }
  if (stateStep?.type !== "new_post") {
    return {
      handled: true,
      effects: [
        { type: "screen", mode: "reply", text: t(locale, "post.need-new-post"), options: { reply_markup: persistentKeyboard(locale) } },
      ],
    };
  }
  const textEn = await translateDraftText(backendDb, message.text, config);
  const draftId = createStudioServices(backendDb, config).posts.create(actorId, { ...message, textEn });
  clearConversationState(backendDb, actorId, "post");
  const preview = postPreviewCard(backendDb, config, actorId, draftId);
  return {
    handled: true,
    effects: [
      {
        type: "screen",
        mode: "reply",
        text: preview.text,
        options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
        card: { kind: "post", draftId },
      },
    ],
  };
}
