import { eq } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { type PresetName, presetName, TARGETS } from "../botTargets.js";
import { effectivePostTargets, registeredPostTargetIds } from "../channels/registry.js";
import { requireDraft } from "../content/index.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { draftSources, draftStoryCards } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import { formatMsk } from "../interfaces/telegram/time.js";
import { mediaPolicyForTarget } from "../publishing/media-policy.js";
import { isPostDraftMutable } from "../publishing/state.js";
import { parseTargets } from "../publishing/targets.js";
import { requirePostEditAllowed } from "../studio/services/post-access.js";
import { postProgressState } from "../studio/services/post-progress.js";
import { type BotLocale, botLocale } from "./i18n.js";

const DRAFT_VIEWS = [
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
] as const;

export type DraftView = (typeof DRAFT_VIEWS)[number];

export function isDraftView(value: string): value is DraftView {
  return (DRAFT_VIEWS as readonly string[]).includes(value);
}

/** RU and EN slot pickers differ only in their slot grids, title and the extra
 * sub-views reachable from the main one, so they are described as data and
 * rendered once. `slots` doubles as the lookup that maps a view to its grid. */
type ScheduleGrid = {
  target: "ru" | "en";
  mainView: DraftView;
  titleKey: MessageKey;
  slots: Partial<Record<DraftView, readonly string[]>>;
  extraViews: Array<{ labelKey: MessageKey; view: DraftView }>;
};

const SCHEDULE_GRIDS: readonly ScheduleGrid[] = [
  {
    target: "ru",
    mainView: "schedule_ru",
    titleKey: "post.schedule-ru-title",
    slots: {
      schedule_ru: ["08:00", "09:00", "10:00", "11:00"],
      schedule_ru_day: ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"],
      schedule_ru_evening: ["18:00", "19:00", "20:00", "21:00", "22:00"],
    },
    extraViews: [
      { labelKey: "post.ru-day", view: "schedule_ru_day" },
      { labelKey: "post.ru-evening", view: "schedule_ru_evening" },
    ],
  },
  {
    target: "en",
    mainView: "schedule_en",
    titleKey: "post.schedule-en-title",
    slots: {
      schedule_en: ["18:00", "19:00", "20:00", "21:00", "22:00", "23:00"],
      schedule_en_us: ["00:00", "01:00", "02:00", "03:00", "04:00"],
    },
    extraViews: [{ labelKey: "post.en-us-night", view: "schedule_en_us" }],
  },
];

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
  config: BackendConfig,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const locale = botLocale(backendDb, draft.actor_id);
  const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
  const registered = registeredPostTargetIds(backendDb);
  const targetRows = registered.size ? TARGETS.filter(({ id }) => registered.has(id)) : TARGETS;
  const sourceCount = unsafeDb(backendDb)
    .db.select({ id: draftSources.id })
    .from(draftSources)
    .where(eq(draftSources.draftId, draftId))
    .all().length;
  const keyboard = new InlineKeyboard();
  const mode = presetName(targets);
  const mutable = isPostDraftMutable(draft.status);

  if (
    !mutable &&
    [
      "platforms",
      "schedule",
      "schedule_ru",
      "schedule_ru_day",
      "schedule_ru_evening",
      "schedule_en",
      "schedule_en_us",
      "confirm_publish",
      "confirm_delete",
    ].includes(view)
  )
    return draftPreview(backendDb, draftId, config, "overview");

  if (view === "platforms") {
    for (let index = 0; index < targetRows.length; index += 2) {
      for (const { id: target, label } of targetRows.slice(index, index + 2))
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

  const scheduleGrid = SCHEDULE_GRIDS.find((grid) => view in grid.slots);
  if (scheduleGrid) {
    const isMainView = view === scheduleGrid.mainView;
    addSlotButtons(keyboard, scheduleGrid.target, scheduleGrid.slots[view] ?? [], draftId);
    if (isMainView) {
      for (const extra of scheduleGrid.extraViews) keyboard.text(t(locale, extra.labelKey), `sched_view:${extra.view}:${draftId}`);
      keyboard
        .row()
        .text(t(locale, "post.enter-time"), `sched_manual:${scheduleGrid.target}:${draftId}`)
        .row()
        .text(t(locale, "common.back"), `preview:${draftId}`);
    } else {
      keyboard.text(t(locale, "common.back"), `sched_view:${scheduleGrid.mainView}:${draftId}`);
    }
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, scheduleGrid.titleKey)}*\n${t(locale, "post.pick-slot-hint")}`,
      keyboard,
    };
  }

  if (view === "confirm_publish") {
    const mediaRu = safeMediaCount(draft.media_ru_json);
    const mediaEn = safeMediaCount(draft.media_en_json) || mediaRu;
    const available = enabledTargetLabels(targets, mediaRu, mediaEn) || t(locale, "post.no-platforms");
    const unavailable = unavailableTargetLabels(targets, mediaRu, mediaEn);
    keyboard.text(t(locale, "post.publish-now-btn"), `publish_confirm:${draftId}`).text(t(locale, "common.back"), `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${t(locale, "post.publish-now-q")}*\n${t(locale, "post.will-send-to")}: ${available}.${unavailable ? `\n⚠️ ${t(locale, "post.will-skip-no-media", { targets: unavailable })}` : ""}`,
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
  if (mutable) {
    keyboard.text(`${modeEmoji} ${t(locale, "post.mode")}: ${modeLabel(mode, locale)}`, `cycle_mode:${draftId}`).row();
    keyboard.text(t(locale, "post.choose-platforms"), `platforms:${draftId}`).row();
    const canEditRu = canEditLocale(backendDb, config, draft.actor_id, draftId, "ru");
    const canEditEn = canEditLocale(backendDb, config, draft.actor_id, draftId, "en");
    if (canEditRu) keyboard.text(t(locale, "post.edit-ru"), `edit_ru:${draftId}`);
    if (canEditEn) keyboard.text(t(locale, "post.edit-en"), `edit_en:${draftId}`);
    if (canEditRu || canEditEn) keyboard.row();
    keyboard.text(`🔗 ${locale === "ru" ? "Источники" : "Sources"}: ${sourceCount}`, `sources:${draftId}`).row();
    keyboard.text(t(locale, "post.publish-btn"), `publish:${draftId}`).text(t(locale, "post.schedule-btn"), `schedule:${draftId}`).row();
    keyboard.text(t(locale, "post.delete-btn"), `cancel:${draftId}`);
  } else {
    const retryable = failedTargets(backendDb, draftId);
    if (retryable.length) {
      keyboard.text(t(locale, "notif.retry-failed"), `post_retry:${draftId}`).row();
      for (const item of retryable)
        keyboard.text(t(locale, "notif.retry-target", { target: item.label }), `post_retry:${draftId}:${item.target}`).row();
    }
    keyboard.text(t(locale, "queue.upcoming-btn"), "queue_home").text(t(locale, "common.menu"), "menu_home");
  }

  const schedule =
    draft.status === "scheduled"
      ? `\n\n${t(locale, "post.scheduled-ru")}: ${formatMsk(draft.scheduled_at ? String(draft.scheduled_at) : null, config)}\n${t(locale, "post.scheduled-en")}: ${formatMsk(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null, config)}`
      : "";
  const mediaRu = safeMediaCount(draft.media_ru_json);
  const mediaEn = safeMediaCount(draft.media_en_json);
  const storyCards = unsafeDb(backendDb).db.select().from(draftStoryCards).where(eq(draftStoryCards.draftId, draftId)).all();
  const storyCardStatus =
    storyCards.length === 0
      ? ""
      : storyCards.every((card) => card.status === "ready")
        ? "\nStory cards: ✓ RU · ✓ EN"
        : `\nStory cards: ${storyCards.map((card) => `${card.locale.toUpperCase()} ${card.status}`).join(" · ")}`;
  const media = mediaRu || mediaEn ? `\n${t(locale, "post.media")}: ${mediaRu || 0} RU · ${mediaEn || mediaRu || 0} EN` : "";
  const enMediaWarning = mediaRu > 0 && mediaEn === 0 ? `\n⚠️ ${t(locale, "post.en-uses-ru-media")}` : "";
  return {
    text: `${draftHeader(draftId, targets, locale)}${media}${storyCardStatus}${enMediaWarning}\n\nRU:\n${String(draft.text_ru || t(locale, "post.media-only")).slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || t(locale, "post.not-translated")).slice(0, 1000)}${schedule}`,
    keyboard,
  };
}

function failedTargets(backendDb: BackendDb, draftId: number): Array<{ target: string; label: string }> {
  try {
    return postProgressState(backendDb, draftId)
      .targets.filter((item) => item.status === "failed" || item.status === "verification_required")
      .map(({ target, label }) => ({ target, label }));
  } catch {
    return [];
  }
}

function canEditLocale(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, locale: "ru" | "en"): boolean {
  try {
    requirePostEditAllowed(backendDb, config, actorId, draftId, new Date(), locale);
    return true;
  } catch {
    return false;
  }
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

function enabledTargetLabels(targets: Record<string, boolean>, mediaRu = 1, mediaEn = 1): string {
  return TARGETS.filter(({ id, locale }) => targets[id] && !isUnavailableForMedia(id, locale, mediaRu, mediaEn))
    .map(({ label }) => label)
    .join(", ");
}

function unavailableTargetLabels(targets: Record<string, boolean>, mediaRu: number, mediaEn: number): string {
  return TARGETS.filter(({ id, locale }) => targets[id] && isUnavailableForMedia(id, locale, mediaRu, mediaEn))
    .map(({ label }) => label)
    .join(", ");
}

function isUnavailableForMedia(target: string, locale: "ru" | "en", mediaRu: number, mediaEn: number): boolean {
  const policy = mediaPolicyForTarget(target, Array.from({ length: locale === "ru" ? mediaRu : mediaEn }));
  return policy.mode === "story-first" && policy.inputCount === 0;
}

export function modeLabel(mode: PresetName, locale: BotLocale = "en"): string {
  if (mode === "full") return t(locale, "mode.full");
  if (mode === "ru") return t(locale, "mode.ru");
  if (mode === "en") return t(locale, "mode.en");
  if (mode === "tg") return t(locale, "mode.tg");
  return t(locale, "mode.manual");
}
