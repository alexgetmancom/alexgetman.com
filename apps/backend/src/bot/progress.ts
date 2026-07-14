import { and, eq, inArray } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import { TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { drafts, postControlCards, publishJobs, siteJobs } from "../db/schema.js";
import { botLocale, ui } from "./i18n.js";
import { parseTargets } from "./message.js";

type ProgressStatus = "published" | "publishing" | "failed" | "waiting" | "cancelled";

export function postProgress(backendDb: BackendDb, draftId: number, details = false): { text: string; keyboard: InlineKeyboard } {
  const draft = backendDb.db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  const locale = botLocale(backendDb, draft.adminId);
  const targets = parseTargets(draft.targetsJson);
  const enabled = TARGETS.filter(([target]) => targets[target]);
  const social = draft.postId == null ? [] : backendDb.db.select().from(publishJobs).where(eq(publishJobs.postId, draft.postId)).all();
  const sites = draft.postId == null ? [] : backendDb.db.select().from(siteJobs).where(eq(siteJobs.postId, draft.postId)).all();
  const statuses = new Map<string, { status: ProgressStatus; error?: string | null }>();
  for (const job of social) statuses.set(job.target, normalize(job.status, job.lastError));
  for (const job of sites) statuses.set(job.reason === "publish_ru" ? "site_ru" : "site_en", normalize(job.status, job.lastError));

  const counts: Record<ProgressStatus, number> = { published: 0, publishing: 0, failed: 0, waiting: 0, cancelled: 0 };
  for (const [target] of enabled) counts[statuses.get(target)?.status ?? "waiting"] += 1;
  const completed = counts.published + counts.failed + counts.cancelled;
  const total = enabled.length;
  const title = counts.failed
    ? ui(locale, "⚠️ Publication has issues", "⚠️ Публикация с ошибками")
    : completed === total && total > 0
      ? ui(locale, "✅ Publication complete", "✅ Публикация завершена")
      : ui(locale, "🚀 Publishing", "🚀 Публикация");
  const lines = [
    `${title} · *Post #${draftId}*`,
    "",
    `${ui(locale, "Progress", "Выполнение")}: *${completed} / ${total}*`,
    `✅ ${ui(locale, "Published", "Опубликовано")}: ${counts.published}`,
    `🔄 ${ui(locale, "Publishing", "Публикуется")}: ${counts.publishing}`,
    `⏳ ${ui(locale, "Waiting", "Ожидают")}: ${counts.waiting}`,
    `❌ ${ui(locale, "Failed", "Ошибок")}: ${counts.failed}`,
  ];
  if (details) {
    for (const group of ["ru", "en"] as const) {
      const items = enabled.filter(([, , targetLocale]) => targetLocale === group);
      if (!items.length) continue;
      lines.push("", `*${group.toUpperCase()}*`);
      for (const [target, label] of items) {
        const item = statuses.get(target) ?? { status: "waiting" as const };
        lines.push(
          `${statusIcon(item.status)} ${label}${item.error && item.status === "failed" ? ` — ${escapeMarkdown(item.error)}` : ""}`,
        );
      }
    }
  }
  const keyboard = new InlineKeyboard();
  if (!details) keyboard.text(ui(locale, "Show details", "Показать детали"), `progress_details:${draftId}`);
  if (details) keyboard.text(ui(locale, "Hide details", "Скрыть детали"), `progress:${draftId}`);
  if (counts.waiting + counts.publishing > 0)
    keyboard.text(ui(locale, "Cancel remaining", "Отменить оставшиеся"), `progress_cancel:${draftId}`);
  const failed = enabled.filter(([target]) => statuses.get(target)?.status === "failed");
  if (failed.length) keyboard.row().text(ui(locale, "Open report", "Открыть отчёт"), `progress_details:${draftId}`);
  return { text: lines.join("\n"), keyboard };
}

export async function refreshPostControlCard(backendDb: BackendDb, bot: Bot | null, draftId: number): Promise<void> {
  if (!bot) return;
  const draft = backendDb.db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  const control = backendDb.db.select().from(postControlCards).where(eq(postControlCards.draftId, draftId)).get();
  if (!draft || !control) return;
  const card = postProgress(backendDb, draftId);
  try {
    await bot.api.editMessageText(control.chatId, control.messageId, card.text, { parse_mode: "Markdown", reply_markup: card.keyboard });
  } catch {
    // A manually removed card must not affect publication.
  }
}

export function cancelRemainingPostJobs(backendDb: BackendDb, draftId: number): void {
  const draft = backendDb.db.select({ postId: drafts.postId }).from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft?.postId) return;
  const now = new Date().toISOString();
  backendDb.db
    .update(publishJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(publishJobs.postId, draft.postId), inArray(publishJobs.status, ["queued", "failed"])))
    .run();
  backendDb.db
    .update(siteJobs)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(siteJobs.postId, draft.postId), inArray(siteJobs.status, ["queued", "failed"])))
    .run();
}

function normalize(status: string, error?: string | null): { status: ProgressStatus; error?: string | null } {
  if (status === "published" || status === "skipped") return { status: "published" };
  if (status === "publishing") return { status: "publishing" };
  if (status === "failed") return error == null ? { status: "failed" } : { status: "failed", error };
  if (status === "cancelled") return { status: "cancelled" };
  return { status: "waiting" };
}

function statusIcon(status: ProgressStatus): string {
  return { published: "✅", publishing: "🔄", waiting: "⏳", failed: "❌", cancelled: "⏹" }[status];
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1").slice(0, 180);
}
