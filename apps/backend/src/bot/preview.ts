import { InlineKeyboard } from "grammy";
import { type PresetName, presetName, TARGETS } from "../botTargets.js";
import { requireDraft } from "../content/drafts.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { t } from "../interfaces/telegram/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { parseTargets } from "../publishing/targets.js";
import { type BotLocale, botLocale } from "./i18n.js";

export type DraftView = "overview" | "modes" | "schedule" | "confirm_publish" | "confirm_delete" | "platforms";

export function draftPreview(
  backendDb: BackendDb,
  draftId: number,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const locale = botLocale(backendDb, draft.admin_id);
  const targets = parseTargets(draft.targets_json);
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
      .text(t(locale, "post.next-free-slot"), `sched_choose:auto:${draftId}`)
      .text("+30 min", `sched_choose:plus30:${draftId}`)
      .row()
      .text("+1 hour", `sched_choose:plus60:${draftId}`)
      .text(t(locale, "post.today-2100"), `sched_choose:today2100:${draftId}`)
      .row()
      .text(t(locale, "post.tomorrow-1000"), `sched_choose:tomorrow1000:${draftId}`)
      .row()
      .text(t(locale, "post.enter-time"), `sched_manual:both:${draftId}`)
      .row()
      .text(t(locale, "common.back"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, "post.schedule-title")}*\n${t(locale, "post.schedule-hint")}`,
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
