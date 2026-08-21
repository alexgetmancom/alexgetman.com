import type { Context } from "grammy";
import type { BackendDb } from "../db/client.js";
import { telegramPostCard, telegramVideoCard } from "../interfaces/telegram/control-cards.js";
import type { PublicationKind } from "./publication-callback.js";

/** The message that currently *is* this publication's card, or null when it has
 * none. Each publication has one live card; anything older is chat history. */
function publicationCardMessageId(backendDb: BackendDb, kind: PublicationKind, draftId: number): number | null {
  const card = kind === "post" ? telegramPostCard(backendDb, draftId) : telegramVideoCard(backendDb, draftId);
  return card?.messageId ?? null;
}

/** Whether this update came from a card that has since been replaced. Acting on
 * a superseded card writes to a screen the operator has scrolled past, so both
 * the callback router and the Story-card continuation ask this one question. */
export function isSupersededCard(ctx: Context, backendDb: BackendDb, kind: PublicationKind, draftId: number): boolean {
  const message = ctx.callbackQuery?.message;
  const messageId = message && "message_id" in message ? message.message_id : null;
  const current = publicationCardMessageId(backendDb, kind, draftId);
  return messageId != null && current != null && messageId !== current;
}
