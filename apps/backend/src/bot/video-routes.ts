import type { PUBLICATION_ACTIONS } from "./session-fsm.js";

/** Canonical action names emitted by the video wizard and control cards. */
export type VideoActionKey = (typeof PUBLICATION_ACTIONS.video)[number];

/** Actions that must come from the current video control card. Retry and cancel
 * notification buttons are also rendered in standalone messages. */
export const VIDEO_CARD_ACTION_KEYS: readonly VideoActionKey[] = [
  "schedule_confirm",
  "schedule",
  "common",
  "individual",
  "now",
  "now_confirm",
  "cancel_ask",
  "remove_ask",
  "cancel",
  "time",
  "sched_pick",
  "sched_manual",
  "remove",
  "edit_menu",
  "edit_field",
  "edit",
];
