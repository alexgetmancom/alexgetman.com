import { eq } from "drizzle-orm";
import { type Bot, InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import { postControlCards } from "../db/schema.js";
import { type PostProgressState, type PostProgressStatus, postProgressState } from "../studio/services/post-progress.js";
import { botLocale, ui } from "./i18n.js";

/** Telegram renderer over the transport-free Studio progress state. */
export function postProgress(backendDb: BackendDb, draftId: number, details = false): { text: string; keyboard: InlineKeyboard } {
  const state = postProgressState(backendDb, draftId);
  return renderPostProgress(state, botLocale(backendDb, state.adminId), details);
}

export function renderPostProgress(
  state: PostProgressState,
  locale: ReturnType<typeof botLocale>,
  details = false,
): { text: string; keyboard: InlineKeyboard } {
  const { counts } = state;
  const completed = counts.published + counts.failed + counts.cancelled;
  const total = state.targets.length;
  const title = counts.failed
    ? ui(locale, "⚠️ Publication has issues", "⚠️ Публикация с ошибками")
    : completed === total && total > 0
      ? ui(locale, "✅ Publication complete", "✅ Публикация завершена")
      : ui(locale, "🚀 Publishing", "🚀 Публикация");
  const lines = [
    `${title} · *Post #${state.draftId}*`,
    "",
    `${ui(locale, "Progress", "Выполнение")}: *${completed} / ${total}*`,
    `✅ ${ui(locale, "Published", "Опубликовано")}: ${counts.published}`,
    `🔄 ${ui(locale, "Publishing", "Публикуется")}: ${counts.publishing}`,
    `⏳ ${ui(locale, "Waiting", "Ожидают")}: ${counts.waiting}`,
    `❌ ${ui(locale, "Failed", "Ошибок")}: ${counts.failed}`,
  ];
  if (details)
    for (const group of ["ru", "en"] as const) {
      const items = state.targets.filter((item) => item.locale === group);
      if (!items.length) continue;
      lines.push("", `*${group.toUpperCase()}*`);
      for (const item of items)
        lines.push(
          `${statusIcon(item.status)} ${item.label}${item.error && item.status === "failed" ? ` — ${escapeMarkdown(item.error)}` : ""}`,
        );
    }
  const keyboard = new InlineKeyboard();
  keyboard.text(
    ui(locale, details ? "Hide details" : "Show details", details ? "Скрыть детали" : "Показать детали"),
    `${details ? "progress" : "progress_details"}:${state.draftId}`,
  );
  if (counts.waiting + counts.publishing > 0)
    keyboard.text(ui(locale, "Cancel remaining", "Отменить оставшиеся"), `progress_cancel:${state.draftId}`);
  if (state.targets.some((item) => item.status === "failed"))
    keyboard.row().text(ui(locale, "Open report", "Открыть отчёт"), `progress_details:${state.draftId}`);
  return { text: lines.join("\n"), keyboard };
}

export async function refreshPostControlCard(backendDb: BackendDb, bot: Bot | null, draftId: number): Promise<void> {
  if (!bot) return;
  const control = backendDb.db.select().from(postControlCards).where(eq(postControlCards.draftId, draftId)).get();
  if (!control) return;
  const card = postProgress(backendDb, draftId);
  try {
    await bot.api.editMessageText(control.chatId, control.messageId, card.text, { parse_mode: "Markdown", reply_markup: card.keyboard });
  } catch {}
}

function statusIcon(status: PostProgressStatus): string {
  return { published: "✅", publishing: "🔄", waiting: "⏳", failed: "❌", cancelled: "⏹" }[status];
}

function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1").slice(0, 180);
}
