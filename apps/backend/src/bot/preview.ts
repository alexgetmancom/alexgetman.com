import { InlineKeyboard } from "grammy";
import { type PresetName, presetName, TARGETS } from "../botTargets.js";
import { postLocales } from "../channels/locales.js";
import { effectivePostTargets, registeredPostTargetIds } from "../channels/registry.js";
import { requireDraft } from "../content/drafts.js";
import { type BackendDb, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { type MessageKey, t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { escapeMarkdown } from "../foundation/markdown.js";
import { truncateUnicode } from "../foundation/text.js";
import { formatZonedDateTime } from "../foundation/time.js";
import { mediaPolicyForTarget } from "../publishing/media-policy.js";
import { isPostDraftMutable, isPostTargetRetryable } from "../publishing/state.js";
import { parseTargets } from "../publishing/targets.js";
import { storyCardsForDraft } from "../story-cards/store.js";
import { createStudioServices } from "../studio/services/index.js";
import { requirePostEditAllowed } from "../studio/services/post-access.js";
import { postProgressState } from "../studio/services/post-progress.js";
import { settingsService } from "../studio/services/settings.js";
import { appendResultNavigation, confirmationKeyboard } from "./dialog-ui.js";
import { publicationCallback } from "./publication-callback.js";
import { createPublicationScheduleEngine, scheduleTimeKeyboard } from "./scheduling.js";

const DRAFT_VIEWS = [
  "overview",
  "schedule",
  "schedule_ru",
  "schedule_ru_day",
  "schedule_ru_evening",
  "schedule_en",
  "schedule_en_us",
  "confirm_publish",
  "confirm_delete",
  "confirm_cancel",
  "platforms",
] as const;

export type DraftView = (typeof DRAFT_VIEWS)[number];

/** Both draft texts share one Telegram message with the header, media line and
 * card status, so each gets a quarter of the 4096-character message budget. */
const PREVIEW_TEXT_LIMIT = 1000;

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

export function draftPreview(
  backendDb: BackendDb,
  draftId: number,
  config: BackendConfig,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const locale = settingsService(backendDb).locale(draft.actor_id);
  const timeConfig = createStudioServices(backendDb, config).settings.timeConfig(draft.actor_id, config);
  const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
  const registered = registeredPostTargetIds(backendDb);
  const targetRows = registered.size ? TARGETS.filter(({ id }) => registered.has(id)) : TARGETS;
  // A language this Studio has connected nothing for has no screens: no slot
  // grid, no schedule line, no text to edit. Offering them is how a draft ends
  // up waiting forever for a date in a language that can never publish.
  const servesEn = postLocales(backendDb).includes("en");
  const keyboard = new InlineKeyboard();
  const mode = presetName(targets);
  const mutable = isPostDraftMutable(draft.status);

  // Every view except the overview edits or acts on the draft, so a frozen draft only ever shows the overview.
  if (!mutable && view !== "overview") return draftPreview(backendDb, draftId, config, "overview");
  if (!servesEn && view.startsWith("schedule_en")) return draftPreview(backendDb, draftId, config, "overview");

  if (view === "platforms") {
    for (let index = 0; index < targetRows.length; index += 2) {
      for (const { id: target, label } of targetRows.slice(index, index + 2))
        keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, publicationCallback("post", "toggle", [draftId, target]));
      keyboard.row();
    }
    keyboard.text(t(locale, "post.back-to-preview"), publicationCallback("post", "view", [draftId, "overview"])).row();
    const enabled = enabledTargetLabels(targets) || t(locale, "post.none");
    return {
      text: `📝 *${t(locale, "post.platforms-title", { id: draftId })}*\n\n${t(locale, "post.active")}: *${enabled}*\n\n${t(locale, "post.toggle-hint")}`,
      keyboard,
    };
  }

  if (view === "schedule") {
    if (draft.status === "scheduled") {
      // One language means one time: the chooser would be a single button in front of the grid it opens.
      if (!servesEn) return draftPreview(backendDb, draftId, config, "schedule_ru");
      keyboard.text(t(locale, "post.change-time-ru"), publicationCallback("post", "view", [draftId, "schedule_ru"])).row();
      keyboard.text(t(locale, "post.change-time-en"), publicationCallback("post", "view", [draftId, "schedule_en"])).row();
      keyboard.text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"]));
      return {
        text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, "post.change-time-title")}*\n${t(locale, "post.change-time-hint")}`,
        keyboard,
      };
    }
    // Without EN there is nothing to stagger against: the only choice left is now or a time.
    if (servesEn)
      keyboard
        .text(t(locale, "post.scope-ru-now"), publicationCallback("post", "sched_scope", [draftId, "ru_now"]))
        .row()
        .text(t(locale, "post.scope-en-now"), publicationCallback("post", "sched_scope", [draftId, "en_now"]))
        .row()
        .text(t(locale, "post.scope-both"), publicationCallback("post", "sched_scope", [draftId, "both"]))
        .row();
    else
      keyboard
        .text(t(locale, "post.scope-ru-only-now"), publicationCallback("post", "sched_scope", [draftId, "ru_now"]))
        .row()
        .text(t(locale, "post.scope-ru-only-later"), publicationCallback("post", "view", [draftId, "schedule_ru"]))
        .row();
    keyboard.text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, "overview"]));
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, "post.schedule-title")}*\n${t(locale, servesEn ? "post.schedule-hint" : "post.schedule-hint-ru-only")}`,
      keyboard,
    };
  }

  const scheduleGrid = SCHEDULE_GRIDS.find((grid) => view in grid.slots);
  if (scheduleGrid) {
    const isMainView = view === scheduleGrid.mainView;
    const scheduleEngine = createPublicationScheduleEngine({
      kind: "post",
      publicationId: draftId,
      scheduleAxis: createStudioServices(backendDb, config).posts.capabilities.scheduleAxis,
      axisKeys: [scheduleGrid.target],
      axisLabel: (key) => key.toUpperCase(),
      slotValues: scheduleGrid.slots[view] ?? [],
    });
    const scheduleKeyboard = scheduleTimeKeyboard({
      axis: {
        values: scheduleEngine.axis.values,
        label: scheduleEngine.axis.label,
        callback: (clock) => scheduleEngine.pickCallback(scheduleGrid.target, clock),
      },
      manual: { label: t(locale, "post.enter-time"), callback: scheduleEngine.manualCallback(scheduleGrid.target) },
      cancel: { label: t(locale, "common.back"), callback: publicationCallback("post", "view", [draftId, "overview"]) },
    });
    if (isMainView) {
      for (const extra of scheduleGrid.extraViews)
        scheduleKeyboard.row().text(t(locale, extra.labelKey), publicationCallback("post", "view", [draftId, extra.view]));
    } else {
      scheduleKeyboard.row().text(t(locale, "common.back"), publicationCallback("post", "view", [draftId, scheduleGrid.mainView]));
    }
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n📅 *${t(locale, scheduleGrid.titleKey)}*\n${t(locale, "post.pick-slot-hint")}`,
      keyboard: scheduleKeyboard,
    };
  }

  if (view === "confirm_publish") {
    const media = mediaCounts(draft.media_ru_json, draft.media_en_json);
    const available = enabledTargetLabels(targets, media.ru, media.enEffective) || t(locale, "post.no-platforms");
    const unavailable = unavailableTargetLabels(targets, media.ru, media.enEffective);
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${t(locale, "post.publish-now-q")}*\n${t(locale, "post.will-send-to")}: ${available}.${unavailable ? `\n⚠️ ${t(locale, "post.will-skip-no-media", { targets: unavailable })}` : ""}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "post.publish-now-btn"), callback: publicationCallback("post", "publish_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("post", "view", [draftId, "overview"]) },
      ),
    };
  }

  if (view === "confirm_delete") {
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${t(locale, "post.delete-q")}*\n${t(locale, "post.delete-warn")}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "post.delete-btn"), callback: publicationCallback("post", "cancel_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("post", "view", [draftId, "overview"]) },
      ),
    };
  }

  if (view === "confirm_cancel") {
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n⚠️ *${t(locale, "post.cancel-publication-q")}*\n${t(locale, "post.cancel-publication-warn")}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "post.cancel-publication-btn"), callback: publicationCallback("post", "cancel_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("post", "view", [draftId, "overview"]) },
      ),
    };
  }

  if (draft.status === "scheduled") {
    const canEditRu = canEditLocale(backendDb, config, draft.actor_id, draftId, "ru");
    const canEditEn = servesEn && canEditLocale(backendDb, config, draft.actor_id, draftId, "en");
    keyboard.text(t(locale, "post.change-time"), publicationCallback("post", "schedule", [draftId])).row();
    if (canEditRu || canEditEn) keyboard.text(t(locale, "post.edit-button"), publicationCallback("post", "edit_menu", [draftId])).row();
    keyboard
      .text(t(locale, "post.cancel-publication"), publicationCallback("post", "cancel", [draftId, "confirm_cancel"]))
      .row()
      .text(t(locale, "queue.back-btn"), "queue_home");
    return {
      text: `${draftHeader(draftId, targets, locale)}\n\n${t(locale, "post.scheduled-ru")}: ${formatZonedDateTime(draft.scheduled_at ? String(draft.scheduled_at) : null, timeConfig.TIMEZONE, timeConfig.TIMEZONE_LABEL)}${servesEn ? `\n${t(locale, "post.scheduled-en")}: ${formatZonedDateTime(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null, timeConfig.TIMEZONE, timeConfig.TIMEZONE_LABEL)}` : ""}`,
      keyboard,
    };
  }

  const modeEmoji = mode === "manual" ? "🛞" : "⚙️";
  if (mutable) {
    keyboard
      .text(`${modeEmoji} ${t(locale, "post.mode")}: ${modeLabel(mode, locale)}`, publicationCallback("post", "cycle_mode", [draftId]))
      .text(t(locale, "post.choose-platforms"), publicationCallback("post", "view", [draftId, "platforms"]))
      .row();
    const canEditRu = canEditLocale(backendDb, config, draft.actor_id, draftId, "ru");
    const canEditEn = servesEn && canEditLocale(backendDb, config, draft.actor_id, draftId, "en");
    if (canEditRu) keyboard.text(t(locale, "post.edit-ru"), publicationCallback("post", "edit_ru", [draftId]));
    if (canEditEn) keyboard.text(t(locale, "post.edit-en"), publicationCallback("post", "edit_en", [draftId]));
    if (canEditRu || canEditEn) keyboard.row();
    keyboard
      .text(t(locale, "post.publish-btn"), publicationCallback("post", "publish", [draftId]))
      .text(t(locale, "post.schedule-btn"), publicationCallback("post", "schedule", [draftId]))
      .row();
    keyboard.text(t(locale, "post.delete-btn"), publicationCallback("post", "cancel", [draftId, "confirm_delete"]));
  } else {
    const unlanded = unlandedTargets(backendDb, draftId);
    if (unlanded.length) {
      if (unlanded.some((item) => isPostTargetRetryable(item.target, item.status)))
        keyboard.text(t(locale, "notif.retry-failed"), publicationCallback("post", "retry", [draftId, "all", "card"]));
      keyboard.text(t(locale, "notif.skip-failed"), publicationCallback("post", "skip", [draftId, "all", "card"])).row();
      for (const item of unlanded) {
        if (isPostTargetRetryable(item.target, item.status))
          keyboard.text(
            t(locale, "notif.retry-target", { target: item.label }),
            publicationCallback("post", "retry", [draftId, item.target, "card"]),
          );
        keyboard
          .text(t(locale, "notif.skip-target", { target: item.label }), publicationCallback("post", "skip", [draftId, item.target, "card"]))
          .row();
      }
    }
    appendResultNavigation(keyboard, locale, "upcoming");
  }

  const media = mediaCounts(draft.media_ru_json, draft.media_en_json);
  const storyCards = storyCardsForDraft(unsafeDb(backendDb).db, draftId);
  const readyCardStatus = servesEn ? "✓ RU · ✓ EN" : "✓ RU";
  const storyCardStatus =
    storyCards.length === 0
      ? ""
      : storyCards.every((card) => card.status === "ready")
        ? `\n${t(locale, "post.story-cards-status", { status: readyCardStatus })}`
        : `\n${t(locale, "post.story-cards-status", { status: storyCards.map((card) => `${card.locale.toUpperCase()} ${card.status}`).join(" · ") })}`;
  const mediaLine =
    media.ru || media.en ? `\n${t(locale, "post.media")}: ${media.ru} RU${servesEn ? ` · ${media.enEffective} EN` : ""}` : "";
  const enMediaWarning = servesEn && media.ru > 0 && media.en === 0 ? `\n⚠️ ${t(locale, "post.en-uses-ru-media")}` : "";
  const enText = servesEn
    ? `\n\nEN:\n${escapeMarkdown(truncateUnicode(String(draft.text_en_approved || draft.text_en_machine || t(locale, "post.not-translated")), PREVIEW_TEXT_LIMIT))}`
    : "";
  return {
    text: `${draftHeader(draftId, targets, locale)}${mediaLine}${storyCardStatus}${enMediaWarning}\n\nRU:\n${escapeMarkdown(truncateUnicode(String(draft.text_ru || t(locale, "post.media-only")), PREVIEW_TEXT_LIMIT))}${enText}`,
    keyboard,
  };
}

/** Every target that did not land, retryable or not: each one can be skipped,
 * and only some of them can be retried. */
function unlandedTargets(backendDb: BackendDb, draftId: number): Array<{ target: string; label: string; status: string }> {
  try {
    return postProgressState(backendDb, draftId)
      .targets.filter((item) => item.status === "failed" || item.status === "verification_required")
      .map(({ target, label, status }) => ({ target, label, status }));
  } catch {
    return [];
  }
}

export function canEditLocale(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number, locale: "ru" | "en"): boolean {
  try {
    requirePostEditAllowed(backendDb, config, actorId, draftId, backendDb.clock.now(), locale);
    return true;
  } catch {
    return false;
  }
}

/** EN falls back to RU media at publish time, so the preview counts both the raw
 * EN attachments (to warn about the fallback) and the effective ones (to decide
 * which targets can actually receive the post). */
function mediaCounts(mediaRuJson: string | null, mediaEnJson: string | null): { ru: number; en: number; enEffective: number } {
  const ru = safeMediaCount(mediaRuJson);
  const en = safeMediaCount(mediaEnJson);
  return { ru, en, enEffective: en || ru };
}

function safeMediaCount(value: string | null): number {
  try {
    const media = value ? JSON.parse(value) : [];
    return Array.isArray(media) ? media.length : 0;
  } catch {
    return 0;
  }
}

function draftHeader(draftId: number, targets: Record<string, boolean>, locale: StudioLocale): string {
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

export function modeLabel(mode: PresetName, locale: StudioLocale = "en"): string {
  if (mode === "full") return t(locale, "mode.full");
  if (mode === "ru") return t(locale, "mode.ru");
  if (mode === "en") return t(locale, "mode.en");
  if (mode === "tg") return t(locale, "mode.tg");
  return t(locale, "mode.manual");
}
