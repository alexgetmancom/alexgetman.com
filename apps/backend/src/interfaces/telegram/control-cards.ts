import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { interfaceBindings } from "../../db/schema.js";

const TELEGRAM = "telegram";

type AnalyticsDashboardCard = { chatId: number; messageId: number; section: "overview" | "posts" | "video"; days: 1 | 7 | 30 };

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

/** The last analytics screen is presentation state, so the Telegram adapter
 * can refresh it without sending the owner a new message every hour. */
export function setTelegramAnalyticsDashboard(
  backendDb: BackendDb,
  adminId: number,
  chatId: number,
  messageId: number,
  section: AnalyticsDashboardCard["section"],
  days: AnalyticsDashboardCard["days"],
): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(interfaceBindings)
    .values({
      interfaceId: TELEGRAM,
      entityType: "analytics_dashboard",
      entityId: adminId,
      conversationId: String(chatId),
      messageId: String(messageId),
      stateJson: { section, days },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [interfaceBindings.interfaceId, interfaceBindings.entityType, interfaceBindings.entityId],
      set: { conversationId: String(chatId), messageId: String(messageId), stateJson: { section, days }, updatedAt: now },
    })
    .run();
}

export function telegramAnalyticsDashboards(backendDb: BackendDb): Array<AnalyticsDashboardCard & { adminId: number }> {
  return backendDb.db
    .select()
    .from(interfaceBindings)
    .where(and(eq(interfaceBindings.interfaceId, TELEGRAM), eq(interfaceBindings.entityType, "analytics_dashboard")))
    .all()
    .flatMap((binding) => {
      const section = binding.stateJson?.section;
      const days = binding.stateJson?.days;
      if ((section !== "overview" && section !== "posts" && section !== "video") || (days !== 1 && days !== 7 && days !== 30)) return [];
      return [{ adminId: binding.entityId, chatId: Number(binding.conversationId), messageId: Number(binding.messageId), section, days }];
    });
}

export function clearTelegramAnalyticsDashboard(backendDb: BackendDb, adminId: number): void {
  backendDb.db
    .delete(interfaceBindings)
    .where(
      and(
        eq(interfaceBindings.interfaceId, TELEGRAM),
        eq(interfaceBindings.entityType, "analytics_dashboard"),
        eq(interfaceBindings.entityId, adminId),
      ),
    )
    .run();
}
