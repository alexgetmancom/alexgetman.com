import { eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { postControlCards, videoDrafts } from "../../db/schema.js";

/** Telegram-only message references. Studio aggregates never need chat/message ids. */
export function setTelegramPostCard(backendDb: BackendDb, draftId: number, chatId: number, messageId: number): void {
  backendDb.db
    .insert(postControlCards)
    .values({ draftId, chatId, messageId, updatedAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: postControlCards.draftId, set: { chatId, messageId, updatedAt: new Date().toISOString() } })
    .run();
}

export function telegramPostCard(backendDb: BackendDb, draftId: number) {
  return backendDb.db.select().from(postControlCards).where(eq(postControlCards.draftId, draftId)).get() ?? null;
}

/** Legacy video columns stay readable for existing cards; their access is confined to this adapter. */
export function setTelegramVideoCard(backendDb: BackendDb, videoDraftId: number, chatId: number, messageId: number): void {
  backendDb.db
    .update(videoDrafts)
    .set({ controlChatId: chatId, controlMessageId: messageId, updatedAt: new Date().toISOString() })
    .where(eq(videoDrafts.id, videoDraftId))
    .run();
}

export function telegramVideoCard(backendDb: BackendDb, videoDraftId: number) {
  const draft = backendDb.db
    .select({ chatId: videoDrafts.controlChatId, messageId: videoDrafts.controlMessageId })
    .from(videoDrafts)
    .where(eq(videoDrafts.id, videoDraftId))
    .get();
  return draft?.chatId && draft.messageId ? draft : null;
}
