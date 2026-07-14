import { InlineKeyboard } from "grammy";
import { PRESETS, TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { formatMsk } from "../publishing/schedule.js";
import { parseTargets } from "../publishing/targets.js";
import { requireDraft } from "./drafts.js";
import { type BotLocale, botLocale, ui } from "./i18n.js";

export type DraftView = "overview" | "modes" | "schedule" | "confirm_publish" | "confirm_delete" | "platforms";

export function draftPreview(
  backendDb: BackendDb,
  draftId: number,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const locale = botLocale(backendDb, draft.admin_id);
  const targets = parseTargets(draft.targets_json);
  const keyboard = new InlineKeyboard();
  const mode = draftMode(targets);

  if (view === "platforms") {
    for (let index = 0; index < TARGETS.length; index += 2) {
      for (const [target, label] of TARGETS.slice(index, index + 2))
        keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
      keyboard.row();
    }
    keyboard.text(ui(locale, "← Back to preview", "← К предпросмотру"), `preview:${draftId}`).row();
    const enabled = enabledTargetLabels(targets) || ui(locale, "none", "нет");
    return {
      text: `📝 *${ui(locale, `Platforms for post #${draftId}`, `Площадки поста #${draftId}`)}*\n\n${ui(locale, "Active", "Активны")}: *${enabled}*\n\n${ui(locale, "Toggle platforms below:", "Выберите площадки ниже:")}`,
      keyboard,
    };
  }

  if (view === "schedule") {
    keyboard
      .text(ui(locale, "📥 Next free slot", "📥 Ближайшее свободное"), `sched_choose:auto:${draftId}`)
      .text("+30 min", `sched_choose:plus30:${draftId}`)
      .row()
      .text("+1 hour", `sched_choose:plus60:${draftId}`)
      .text(ui(locale, "Today 21:00", "Сегодня 21:00"), `sched_choose:today2100:${draftId}`)
      .row()
      .text(ui(locale, "Tomorrow 10:00", "Завтра 10:00"), `sched_choose:tomorrow1000:${draftId}`)
      .row()
      .text(ui(locale, "Enter time", "Ввести время"), `sched_manual:both:${draftId}`)
      .row()
      .text(ui(locale, "← Back", "← Назад"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${ui(locale, "Schedule", "Планирование")}*\n${ui(locale, "Choose a slot or enter a time.", "Выберите слот или введите время.")}`,
      keyboard,
    };
  }

  if (view === "confirm_publish") {
    const enabled = enabledTargetLabels(targets) || ui(locale, "no platforms selected", "площадки не выбраны");
    keyboard
      .text(ui(locale, "✅ Publish now", "✅ Опубликовать"), `publish_confirm:${draftId}`)
      .text(ui(locale, "← Back", "← Назад"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${ui(locale, "Publish now?", "Опубликовать сейчас?")}*\n${ui(locale, "Will be sent to", "Будет отправлено в")}: ${enabled}.`,
      keyboard,
    };
  }

  if (view === "confirm_delete") {
    keyboard
      .text(ui(locale, "🗑 Delete draft", "🗑 Удалить черновик"), `cancel_confirm:${draftId}`)
      .text(ui(locale, "← Back", "← Назад"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${ui(locale, "Delete this draft?", "Удалить этот черновик?")}*\n${ui(locale, "Unstarted scheduled work will be cancelled.", "Незапущенные запланированные задачи будут отменены.")}`,
      keyboard,
    };
  }

  const modeEmoji = mode === "manual" ? "🛞" : "⚙️";
  keyboard.text(`${modeEmoji} ${ui(locale, "Mode", "Режим")}: ${modeLabel(mode, locale)}`, `cycle_mode:${draftId}`).row();
  keyboard.text(ui(locale, "🌐 Choose platforms", "🌐 Выбрать площадки"), `platforms:${draftId}`).row();
  keyboard
    .text(ui(locale, "Edit RU", "Изменить RU"), `edit_ru:${draftId}`)
    .text(ui(locale, "Edit EN", "Изменить EN"), `edit_en:${draftId}`)
    .row();
  keyboard
    .text(ui(locale, "▶️ Publish now", "▶️ Опубликовать"), `publish:${draftId}`)
    .text(ui(locale, "📅 Schedule", "📅 Запланировать"), `schedule:${draftId}`)
    .row();
  keyboard.text(ui(locale, "🗑 Delete draft", "🗑 Удалить черновик"), `cancel:${draftId}`);

  const schedule =
    draft.status === "scheduled"
      ? `\n\n${ui(locale, "Scheduled RU", "Запланировано RU")}: ${formatMsk(draft.scheduled_at ? String(draft.scheduled_at) : null)}\n${ui(locale, "Scheduled EN", "Запланировано EN")}: ${formatMsk(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null)}`
      : "";
  const mediaRu = safeMediaCount(draft.media_ru_json);
  const mediaEn = safeMediaCount(draft.media_en_json);
  const media = mediaRu || mediaEn ? `\n${ui(locale, "Media", "Медиа")}: ${mediaRu || 0} RU · ${mediaEn || mediaRu || 0} EN` : "";
  const enMediaWarning = mediaRu > 0 && mediaEn === 0 ? `\n⚠️ ${ui(locale, "EN uses RU media", "EN использует RU-медиа")}` : "";
  return {
    text: `${draftHeader(draftId, targets, locale)}${media}${enMediaWarning}\n\nRU:\n${String(draft.text_ru || ui(locale, "[media only]", "[только медиа]")).slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || ui(locale, "[not translated]", "[не переведено]")).slice(0, 1000)}${schedule}`,
    keyboard,
  };
}

function safeMediaCount(value: string | null): number {
  try {
    const media = value ? JSON.parse(value) : [];
    return Array.isArray(media) ? media.length : 0;
  } catch {
    return 0;
  }
}

function draftHeader(draftId: number, targets: Record<string, boolean>, locale: BotLocale): string {
  return `📝 *${ui(locale, `Post #${draftId}`, `Пост #${draftId}`)}*\n${ui(locale, "Mode", "Режим")}: *${modeLabel(draftMode(targets), locale)}* · ${ui(locale, "Platforms", "Площадки")}: *${Object.values(targets).filter(Boolean).length}*`;
}

function enabledTargetLabels(targets: Record<string, boolean>): string {
  return TARGETS.filter(([id]) => targets[id])
    .map(([, label]) => label)
    .join(", ");
}

function draftMode(targets: Record<string, boolean>): keyof typeof PRESETS | "manual" {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (TARGETS.every(([target]) => Boolean(targets[target]) === Boolean(preset[target]))) return name as keyof typeof PRESETS;
  }
  return "manual";
}

export function modeLabel(mode: keyof typeof PRESETS | "manual", locale: BotLocale = "en"): string {
  if (mode === "full") return ui(locale, "Full", "Полный");
  if (mode === "ru") return ui(locale, "RU only", "Только RU");
  if (mode === "en") return ui(locale, "EN only", "Только EN");
  if (mode === "tg") return ui(locale, "Telegram only", "Только Telegram");
  return ui(locale, "Custom", "Свой");
}
