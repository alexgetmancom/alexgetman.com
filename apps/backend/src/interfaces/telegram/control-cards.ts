import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { interfaceBindings } from "../../db/schema.js";

const TELEGRAM = "telegram";

/** Telegram-only message references. Studio aggregates never need chat/message ids. */
export function setTelegramPostCard(backendDb: BackendDb, draftId: number, chatId: number, messageId: number): void {
  backendDb.db
    .insert(interfaceBindings)
    .values({
      interfaceId: TELEGRAM,
      entityType: "draft",
      entityId: draftId,
      conversationId: String(chatId),
      messageId: String(messageId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [interfaceBindings.interfaceId, interfaceBindings.entityType, interfaceBindings.entityId],
      set: { conversationId: String(chatId), messageId: String(messageId), updatedAt: new Date().toISOString() },
    })
    .run();
}

export function telegramPostCard(backendDb: BackendDb, draftId: number) {
  const binding = backendDb.db
    .select()
    .from(interfaceBindings)
    .where(
      and(eq(interfaceBindings.interfaceId, TELEGRAM), eq(interfaceBindings.entityType, "draft"), eq(interfaceBindings.entityId, draftId)),
    )
    .get();
  return binding ? { chatId: Number(binding.conversationId), messageId: Number(binding.messageId) } : null;
}

/** Separate binding: a progress card is transient delivery UI, not the draft editor. */
export function setTelegramPostProgressCard(
  backendDb: BackendDb,
  draftId: number,
  chatId: number,
  messageId: number,
  details = false,
): void {
  backendDb.db
    .insert(interfaceBindings)
    .values({
      interfaceId: TELEGRAM,
      entityType: "post_progress",
      entityId: draftId,
      conversationId: String(chatId),
      messageId: String(messageId),
      stateJson: { details },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [interfaceBindings.interfaceId, interfaceBindings.entityType, interfaceBindings.entityId],
      set: { conversationId: String(chatId), messageId: String(messageId), stateJson: { details }, updatedAt: new Date().toISOString() },
    })
    .run();
}

export function telegramPostProgressCard(backendDb: BackendDb, draftId: number) {
  const binding = backendDb.db
    .select()
    .from(interfaceBindings)
    .where(
      and(
        eq(interfaceBindings.interfaceId, TELEGRAM),
        eq(interfaceBindings.entityType, "post_progress"),
        eq(interfaceBindings.entityId, draftId),
      ),
    )
    .get();
  return binding
    ? { chatId: Number(binding.conversationId), messageId: Number(binding.messageId), details: binding.stateJson?.details === true }
    : null;
}

export function setTelegramVideoCard(backendDb: BackendDb, videoDraftId: number, chatId: number, messageId: number): void {
  backendDb.db
    .insert(interfaceBindings)
    .values({
      interfaceId: TELEGRAM,
      entityType: "video_draft",
      entityId: videoDraftId,
      conversationId: String(chatId),
      messageId: String(messageId),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [interfaceBindings.interfaceId, interfaceBindings.entityType, interfaceBindings.entityId],
      set: { conversationId: String(chatId), messageId: String(messageId), updatedAt: new Date().toISOString() },
    })
    .run();
}

export function telegramVideoCard(backendDb: BackendDb, videoDraftId: number) {
  const binding = backendDb.db
    .select()
    .from(interfaceBindings)
    .where(
      and(
        eq(interfaceBindings.interfaceId, TELEGRAM),
        eq(interfaceBindings.entityType, "video_draft"),
        eq(interfaceBindings.entityId, videoDraftId),
      ),
    )
    .get();
  return binding ? { chatId: Number(binding.conversationId), messageId: Number(binding.messageId) } : null;
}
