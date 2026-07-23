import { eq } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { type PresetName, presetName, TARGETS } from "../botTargets.js";
import { requireDraft } from "../content/drafts.js";
import type { BackendDb } from "../db/client.js";
import { draftSources } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { parseTargets } from "../publishing/targets.js";
import { type BotLocale, botLocale } from "./i18n.js";

export type DraftView =
  | "overview"
  | "modes"
  | "schedule"
  | "schedule_ru"
  | "schedule_ru_day"
  | "schedule_ru_evening"
  | "schedule_en"
  | "schedule_en_us"
  | "confirm_publish"
  | "confirm_delete"
  | "platforms";

const DRAFT_VIEWS: readonly DraftView[] = [
  "overview",
  "modes",
  "schedule",
  "schedule_ru",
  "schedule_ru_day",
  "schedule_ru_evening",
  "schedule_en",
  "schedule_en_us",
  "confirm_publish",
  "confirm_delete",
  "platforms",
];

export function isDraftView(value: string): value is DraftView {
  return (DRAFT_VIEWS as readonly string[]).includes(value);
}

const RU_MAIN_SLOTS = ["08:00", "09:00", "10:00", "11:00"];
const RU_DAY_SLOTS = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
const RU_EVENING_SLOTS = ["18:00", "19:00", "20:00", "21:00", "22:00"];
const EN_MAIN_SLOTS = ["18:00", "19:00", "20:00", "21:00", "22:00", "23:00"];
const EN_US_SLOTS = ["00:00", "01:00", "02:00", "03:00", "04:00"];

function addSlotButtons(keyboard: InlineKeyboard, target: "ru" | "en", clocks: readonly string[], draftId: number): InlineKeyboard {
  for (let index = 0; index < clocks.length; index += 2) {
    for (const clock of clocks.slice(index, index + 2)) keyboard.text(clock, `sched_pick:${target}:${clock.replace(":", "")}:${draftId}`);
    keyboard.row();
  }
  return keyboard;
}

export function draftPreview(
  backendDb: BackendDb,
  draftId: number,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const locale = botLocale(backendDb, draft.admin_id);
  const targets = parseTargets(draft.targets_json);
  const sourceCount = backendDb.db.select({ id: draftSources.id }).from(draftSources).where(eq(draftSources.draftId, draftId)).all().length;
  const keyboard = new InlineKeyboard();
  const mode = presetName(targets);

  if (view === "platforms") {
    for (let index = 0; index < TARGETS.length; index += 2) {
      for (const [target, label] of TARGETS.slice(index, index + 2))
        keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
      keyboard.row();
    }
    keyboard.text(t(locale, "post.back-to-preview"), `preview:${draftId}`).row();
    const enabled = enabledTargetLabels(targets) || t(locale, "post.none");
    return {
      text: `📝 *${t(locale, "post.platforms-title", { id: draftId })}*\n\n${t(locale, "post.active")}: *${enabled}*\n\n${t(locale, "post.toggle-hint")}`,
      keyboard,
    };
  }

  if (view === "schedule") {
    keyboard
      .text(t(locale, "post.scope-ru-now"), `sched_scope:ru_now:${draftId}`)
      .row()
      .text(t(locale, "post.scope-en-now"), `sched_scope:en_now:${draftId}`)
      .row()
      .text(t(locale, "post.scope-both"), `sched_scope:both:${draftId}`)
      .row()
      .text(t(locale, "common.back"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, "post.schedule-title")}*\n${t(locale, "post.schedule-hint")}`,
      keyboard,
    };
  }

  if (view === "schedule_ru" || view === "schedule_ru_day" || view === "schedule_ru_evening") {
    const slots = view === "schedule_ru" ? RU_MAIN_SLOTS : view === "schedule_ru_day" ? RU_DAY_SLOTS : RU_EVENING_SLOTS;
    addSlotButtons(keyboard, "ru", slots, draftId);
    if (view === "schedule_ru") {
      keyboard
        .text(t(locale, "post.ru-day"), `sched_view:schedule_ru_day:${draftId}`)
        .text(t(locale, "post.ru-evening"), `sched_view:schedule_ru_evening:${draftId}`)
        .row()
        .text(t(locale, "post.next-free-slot"), `sched_auto:ru:${draftId}`)
        .row()
        .text(t(locale, "post.enter-time"), `sched_manual:ru:${draftId}`)
        .row()
        .text(t(locale, "common.back"), `preview:${draftId}`);
    } else {
      keyboard.text(t(locale, "common.back"), `sched_view:schedule_ru:${draftId}`);
    }
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, "post.schedule-ru-title")}*\n${t(locale, "post.pick-slot-hint")}`,
      keyboard,
    };
  }

  if (view === "schedule_en" || view === "schedule_en_us") {
    const slots = view === "schedule_en" ? EN_MAIN_SLOTS : EN_US_SLOTS;
    addSlotButtons(keyboard, "en", slots, draftId);
    if (view === "schedule_en") {
      keyboard
        .text(t(locale, "post.en-us-night"), `sched_view:schedule_en_us:${draftId}`)
        .row()
        .text(t(locale, "post.next-free-slot"), `sched_auto:en:${draftId}`)
        .row()
        .text(t(locale, "post.enter-time"), `sched_manual:en:${draftId}`)
        .row()
        .text(t(locale, "common.back"), `preview:${draftId}`);
    } else {
      keyboard.text(t(locale, "common.back"), `sched_view:schedule_en:${draftId}`);
    }
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, "post.schedule-en-title")}*\n${t(locale, "post.pick-slot-hint")}`,
      keyboard,
    };
  }

  if (view === "confirm_publish") {
    const enabled = enabledTargetLabels(targets) || t(locale, "post.no-platforms");
    keyboard.text(t(locale, "post.publish-now-btn"), `publish_confirm:${draftId}`).text(t(locale, "common.back"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${t(locale, "post.publish-now-q")}*\n${t(locale, "post.will-send-to")}: ${enabled}.`,
      keyboard,
    };
  }

  if (view === "confirm_delete") {
    keyboard.text(t(locale, "post.delete-btn"), `cancel_confirm:${draftId}`).text(t(locale, "common.back"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${t(locale, "post.delete-q")}*\n${t(locale, "post.delete-warn")}`,
      keyboard,
    };
  }

  const modeEmoji = mode === "manual" ? "🛞" : "⚙️";
  keyboard.text(`${modeEmoji} ${t(locale, "post.mode")}: ${modeLabel(mode, locale)}`, `cycle_mode:${draftId}`).row();
  keyboard.text(t(locale, "post.choose-platforms"), `platforms:${draftId}`).row();
  keyboard.text(t(locale, "post.edit-ru"), `edit_ru:${draftId}`).text(t(locale, "post.edit-en"), `edit_en:${draftId}`).row();
  keyboard.text(`🔗 ${locale === "ru" ? "Источники" : "Sources"}: ${sourceCount}`, `sources:${draftId}`).row();
  keyboard.text(t(locale, "post.publish-btn"), `publish:${draftId}`).text(t(locale, "post.schedule-btn"), `schedule:${draftId}`).row();
  keyboard.text(t(locale, "post.delete-btn"), `cancel:${draftId}`);

  const schedule =
    draft.status === "scheduled"
      ? `\n\n${t(locale, "post.scheduled-ru")}: ${formatMsk(draft.scheduled_at ? String(draft.scheduled_at) : null, config)}\n${t(locale, "post.scheduled-en")}: ${formatMsk(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null, config)}`
      : "";
  const mediaRu = safeMediaCount(draft.media_ru_json);
  const mediaEn = safeMediaCount(draft.media_en_json);
  const media = mediaRu || mediaEn ? `\n${t(locale, "post.media")}: ${mediaRu || 0} RU · ${mediaEn || mediaRu || 0} EN` : "";
  const enMediaWarning = mediaRu > 0 && mediaEn === 0 ? `\n⚠️ ${t(locale, "post.en-uses-ru-media")}` : "";
  return {
    text: `${draftHeader(draftId, targets, locale)}${media}${enMediaWarning}\n\nRU:\n${String(draft.text_ru || t(locale, "post.media-only")).slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || t(locale, "post.not-translated")).slice(0, 1000)}${schedule}`,
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
  return `📝 *${t(locale, "post.heading", { id: draftId })}*\n${t(locale, "post.mode")}: *${modeLabel(presetName(targets), locale)}* · ${t(locale, "post.platforms")}: *${Object.values(targets).filter(Boolean).length}*`;
}

function enabledTargetLabels(targets: Record<string, boolean>): string {
  return TARGETS.filter(([id]) => targets[id])
    .map(([, label]) => label)
    .join(", ");
}

export function modeLabel(mode: PresetName, locale: BotLocale = "en"): string {
  if (mode === "full") return t(locale, "mode.full");
  if (mode === "ru") return t(locale, "mode.ru");
  if (mode === "en") return t(locale, "mode.en");
  if (mode === "tg") return t(locale, "mode.tg");
  return t(locale, "mode.manual");
}
