import type { Context } from "grammy";
import { flowStepInput } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { describeError, t } from "../foundation/i18n/index.js";
import { createStudioServices } from "../studio/services/index.js";
import { appendPendingAlbum } from "./albums.js";
import { clearConversationState, getConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard } from "./dialog-ui.js";
import { executePublicationEffects, type PublicationMessageResult } from "./effects.js";
import { botLocale } from "./i18n.js";
import { persistentKeyboard } from "./menu-render.js";
import { extractMessage } from "./message.js";
import { POST_FLOW, postStateStep } from "./post-actions.js";
import { applyAdminState } from "./post-input-actions.js";
import { translatePostText } from "./post-translation.js";
import { parseSessionCallback, publicationCallback } from "./publication-callback.js";
import { openPublicationFlow } from "./publication-flow.js";
import { publicationRenderers } from "./publication-renderers.js";

/** The conversational text-post screen. It owns user input and keeps the
 * root bot router limited to authorization and screen dispatch.
 *
 * `reply` opens the screen as a new message; `edit` turns the message the
 * operator just tapped into it, which is what a callback should do. */
async function renderPostScreen(ctx: Context, backendDb: BackendDb, mode: "reply" | "edit"): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const revision = openPublicationFlow(backendDb, actorId, {
    kind: "post",
    draftId: null,
    step: "new_post",
    data: {},
    controlMessageId: null,
  }).revision;
  const locale = botLocale(backendDb, actorId);
  const prompt = t(locale, "post.dialog-prompt");
  const options = { reply_markup: cancelPromptKeyboard(locale, publicationCallback("post", "cancel_dialog", [], revision)) };
  await executePublicationEffects(ctx, backendDb, [{ type: "screen", mode, text: prompt, options }]);
}

export async function startPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  await renderPostScreen(ctx, backendDb, "reply");
}

export async function openPostScreen(ctx: Context, backendDb: BackendDb): Promise<void> {
  await renderPostScreen(ctx, backendDb, "edit");
}

export async function handlePostMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  const locale = botLocale(backendDb, actorId);
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
  const textEn = await translatePostText(message.text, config);
  const draftId = createStudioServices(backendDb, config).posts.create(actorId, { ...message, textEn });
  clearConversationState(backendDb, actorId, "post");
  const preview = publicationRenderers(backendDb, config).post.card({
    backendDb,
    pipeline: createStudioServices(backendDb, config).posts,
    actorId,
    publicationId: draftId,
    config,
    locale,
  });
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

export async function handlePostScreenCallback(ctx: Context, backendDb: BackendDb): Promise<boolean> {
  const rawData = ctx.callbackQuery?.data;
  if (!rawData || parseSessionCallback(rawData).data !== "menu_text") return false;
  await executePublicationEffects(ctx, backendDb, [{ type: "answer-callback" }]);
  await openPostScreen(ctx, backendDb);
  return true;
}
