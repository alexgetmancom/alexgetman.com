import { InlineKeyboard } from "grammy";
import { versionedCallback } from "./session-fsm.js";

/** The values along which a scheduling screen lets an operator move. */
export type ScheduleAxis<T extends string> = {
  values: readonly T[];
  label: (value: T) => string;
  callback: (value: T) => string;
};

/** Renders an axis as two-column slot rows. The caller owns the surrounding
 * navigation because post and video screens have different footer actions. */
export function appendScheduleAxisButtons<T extends string>(
  keyboard: InlineKeyboard,
  axis: ScheduleAxis<T>,
  revision?: number | null,
): InlineKeyboard {
  for (let index = 0; index < axis.values.length; index += 2) {
    for (const value of axis.values.slice(index, index + 2))
      keyboard.text(axis.label(value), versionedCallback(axis.callback(value), revision));
    if (index + 2 < axis.values.length) keyboard.row();
  }
  return keyboard;
}

/** Shared posting-hour presets used by the flat video schedule axis. */
export const SCHEDULE_SLOT_PRESETS = ["08:00", "11:00", "13:00", "18:00", "20:00", "22:00"] as const;

/** Builds the common video-style time picker: slot presets, manual entry and
 * a versioned cancel action. Domain-specific confirmation remains outside. */
export function scheduleTimeKeyboard<T extends string>(options: {
  axis: ScheduleAxis<T>;
  revision?: number | null;
  manual: { label: string; callback: string };
  cancel: { label: string; callback: string };
}): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  appendScheduleAxisButtons(keyboard, options.axis, options.revision);
  keyboard.row();
  keyboard.text(options.manual.label, versionedCallback(options.manual.callback, options.revision)).row();
  keyboard.text(options.cancel.label, versionedCallback(options.cancel.callback, options.revision));
  return keyboard;
}

/** Builds the common confirmation footer while preserving each flow's
 * callback namespace and optional session revision. */
export function scheduleConfirmationKeyboard(options: {
  revision?: number | null;
  confirm: { label: string; callback: string };
  back: { label: string; callback: string };
}): InlineKeyboard {
  return new InlineKeyboard()
    .text(options.confirm.label, versionedCallback(options.confirm.callback, options.revision))
    .text(options.back.label, versionedCallback(options.back.callback, options.revision));
}
