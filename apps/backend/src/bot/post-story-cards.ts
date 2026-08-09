import { type Context, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../foundation/i18n/index.js";
import { log } from "../foundation/logger.js";
import { telegramPostCard } from "../interfaces/telegram/control-cards.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { executePublicationEffects, type PublicationEffect } from "./effects.js";
import { publicationCallback } from "./publication-callback.js";

type StoryCard = { locale: string; status: string; localPath: string | null };

export async function showStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): Promise<PublicationEffect[] | null> {
  const posts = createStudioServices(backendDb, config).posts;
  const cards = posts.preview(actorId, draftId).storyCards;
  if (cards.length === 0) return null;
  const locale = settingsService(backendDb).locale(actorId);
  if (!cardsReady(cards)) {
    const effects: PublicationEffect[] = [{ type: "toast", text: t(locale, "post.story-cards-generating") }];
    queueStoryCardChoice(ctx, backendDb, config, actorId, draftId, intent);
    return effects;
  }
  return [...sendStoryCardChoice(backendDb, actorId, draftId, intent, cards)];
}

const pendingStoryCardChoices = new Map<string, Promise<void>>();

/** The Story worker owns rendering. This lightweight continuation only waits
 * for its durable result and sends the choice as a follow-up Telegram message. */
function queueStoryCardChoice(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): void {
  const key = `${actorId}:${draftId}:${intent}`;
  if (pendingStoryCardChoices.has(key)) return;
  const task = waitForStoryCards(ctx, backendDb, config, actorId, draftId, intent).finally(() => pendingStoryCardChoices.delete(key));
  pendingStoryCardChoices.set(key, task);
  void task.catch((error) => {
    logStoryCardChoiceFailure(error, actorId, draftId);
  });
}

async function waitForStoryCards(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
): Promise<void> {
  const posts = createStudioServices(backendDb, config).posts;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await delay(1_000);
    const cards = posts.preview(actorId, draftId).storyCards;
    if (!cardsReady(cards)) continue;
    if (isStalePostCard(ctx, backendDb, draftId)) return;
    await executePublicationEffects(ctx, backendDb, sendStoryCardChoice(backendDb, actorId, draftId, intent, cards));
    return;
  }
}

function sendStoryCardChoice(
  backendDb: BackendDb,
  actorId: number,
  draftId: number,
  intent: "publish" | "schedule",
  cards: StoryCard[],
): PublicationEffect[] {
  const locale = settingsService(backendDb).locale(actorId);
  const effects: PublicationEffect[] = [];
  for (const cardLocale of ["ru", "en"] as const) {
    const card = cards.find((item) => item.locale === cardLocale);
    if (card?.localPath) effects.push({ type: "photo", path: card.localPath, options: { caption: `Story · ${cardLocale.toUpperCase()}` } });
  }
  const keyboard = new InlineKeyboard();
  if (intent === "publish") {
    keyboard
      .text(t(locale, "post.story-cards-all"), publicationCallback("post", "story_publish_all", [draftId]))
      .row()
      .text(t(locale, "post.story-cards-site-only"), publicationCallback("post", "story_publish_site", [draftId]));
  } else {
    keyboard
      .text(t(locale, "post.story-cards-all-schedule"), publicationCallback("post", "story_schedule_all", [draftId]))
      .row()
      .text(t(locale, "post.story-cards-site-only-schedule"), publicationCallback("post", "story_schedule_site", [draftId]));
  }
  keyboard.row().text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"]));
  effects.push({
    type: "prompt",
    text: t(locale, "post.story-cards-question"),
    options: { parse_mode: "Markdown", reply_markup: keyboard },
    card: { kind: "post", draftId },
  });
  return effects;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logStoryCardChoiceFailure(error: unknown, actorId: number, draftId: number): void {
  log("error", "failed to send Story card choice", {
    actorId,
    draftId,
    error: error instanceof Error ? error.message : String(error),
  });
}

function cardsReady(cards: StoryCard[]): boolean {
  return ["ru", "en"].every((locale) => cards.some((card) => card.locale === locale && card.status === "ready" && card.localPath));
}

function isStalePostCard(ctx: Context, backendDb: BackendDb, draftId: number): boolean {
  const current = telegramPostCard(backendDb, draftId)?.messageId;
  const callbackMessage = ctx.callbackQuery?.message;
  const messageId = callbackMessage && "message_id" in callbackMessage ? callbackMessage.message_id : null;
  return messageId != null && current != null && messageId !== current;
}
