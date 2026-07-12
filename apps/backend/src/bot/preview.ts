import { eq } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { PRESETS, TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { formatMsk } from "../publishingSchedule.js";
import { requireDraft } from "./drafts.js";
import { parseTargets } from "./message.js";

type DraftView = "overview" | "modes" | "schedule" | "confirm_publish";

export function draftPreview(
  backendDb: BackendDb,
  draftId: number,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const targets = parseTargets(draft.targets_json);
  const keyboard = new InlineKeyboard();
  const mode = draftMode(targets);
  if (view === "modes") {
    keyboard
      .text(`${mode === "full" ? "✓ " : ""}Full`, `preset:full:${draftId}`)
      .text(`${mode === "ru" ? "✓ " : ""}RU only`, `preset:ru:${draftId}`)
      .row()
      .text(`${mode === "en" ? "✓ " : ""}EN only`, `preset:en:${draftId}`)
      .text(`${mode === "tg" ? "✓ " : ""}TG only`, `preset:tg:${draftId}`)
      .row()
      .text(`${mode === "manual" ? "✓ " : ""}Manual`, `preset:manual:${draftId}`)
      .row();
  } else if (view === "schedule") {
    keyboard
      .text("📥 Следующий слот", `sched_auto:${draftId}`)
      .text("+30 мин", `sched_preset:plus30:${draftId}`)
      .row()
      .text("+1 час", `sched_preset:plus60:${draftId}`)
      .text("Сегодня 21:00", `sched_preset:today2100:${draftId}`)
      .row()
      .text("Завтра 10:00", `sched_preset:tomorrow1000:${draftId}`)
      .row()
      .text("⌨ Ввести время для RU+EN", `sched_manual:both:${draftId}`)
      .row()
      .text("← Назад", `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets)}\n\n📅 *Планирование*\nВыберите слот или введите дату в формате \`15.07 18:30\` (МСК).`,
      keyboard,
    };
  } else if (view === "confirm_publish") {
    const enabled = enabledTargetLabels(targets);
    keyboard.text("✅ Да, опубликовать", `publish_confirm:${draftId}`).text("← Назад", `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets)}\n\n⚠️ *Подтвердите публикацию сейчас*\nБудет отправлено: ${enabled || "нет выбранных площадок"}.`,
      keyboard,
    };
  } else keyboard.text(`⚙️ Режим: ${modeLabel(mode)}`, `mode:${draftId}`).row();
  for (let index = 0; index < TARGETS.length; index += 2) {
    for (const [target, label] of TARGETS.slice(index, index + 2))
      keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
    keyboard.row();
  }
  keyboard.text("Edit RU", `edit_ru:${draftId}`).text("Edit EN", `edit_en:${draftId}`).row();
  keyboard.text("Replace RU media", `replace_ru_media:${draftId}`).text("Replace EN media", `replace_en_media:${draftId}`).row();
  keyboard.text("▶️ Publish now", `publish:${draftId}`).text("📅 Schedule", `schedule:${draftId}`).row();
  keyboard.text("Cancel", `cancel:${draftId}`);
  const schedule =
    draft.status === "scheduled"
      ? `\n\nScheduled RU: ${formatMsk(draft.scheduled_at)}\nScheduled EN: ${formatMsk(draft.scheduled_en_at)}`
      : "";
  return {
    text: `${draftHeader(draftId, targets)}\n\nRU:\n${String(draft.text_ru || "[media only]").slice(0, 700)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || "[not translated]").slice(0, 700)}${schedule}`,
    keyboard,
  };
}

function draftHeader(draftId: number, targets: Record<string, boolean>): string {
  return `📝 *Обычная публикация #${draftId}*\nРежим: *${modeLabel(draftMode(targets))}* · Площадок: *${Object.values(targets).filter(Boolean).length}* · Языки: *${languages(targets)}*`;
}

function languages(targets: Record<string, boolean>): string {
  const enabled = TARGETS.filter(([id]) => targets[id]);
  const hasRu = enabled.some(([, , locale]) => locale === "ru");
  const hasEn = enabled.some(([, , locale]) => locale === "en");
  return hasRu && hasEn ? "RU + EN" : hasRu ? "RU" : hasEn ? "EN" : "—";
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

function modeLabel(mode: keyof typeof PRESETS | "manual"): string {
  switch (mode) {
    case "full":
      return "Full";
    case "ru":
      return "RU only";
    case "en":
      return "EN only";
    case "tg":
      return "TG only";
    default:
      return "Manual";
  }
}

export function toggleDraftTarget(backendDb: BackendDb, draftId: number, target: string): void {
  const row = backendDb.db.select({ targetsJson: drafts.targetsJson }).from(drafts).where(eq(drafts.id, draftId)).get();
  const targets = parseTargets(row?.targetsJson);
  targets[target] = !targets[target];
  backendDb.db
    .update(drafts)
    .set({ targetsJson: JSON.stringify(targets), updatedAt: new Date().toISOString() })
    .where(eq(drafts.id, draftId))
    .run();
}
