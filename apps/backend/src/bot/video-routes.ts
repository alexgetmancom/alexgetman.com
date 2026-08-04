/** Callback names emitted by the video wizard and video control cards. */
export const VIDEO_ACTION_KEYS = [
  "video_start",
  "video_locale",
  "video_cancel_dialog",
  "video_toggle",
  "video_targets_done",
  "video_game_skip",
  "video_meta_back",
  "video_open",
  "video_retry",
  "video_cancel_notice",
  "video_schedule_confirm",
  "video_schedule",
  "video_common",
  "video_individual",
  "video_now",
  "video_now_confirm",
  "video_cancel_ask",
  "video_remove_ask",
  "video_cancel",
  "video_time",
  "video_sched_pick",
  "video_sched_manual",
  "video_remove",
  "video_edit_menu",
  "video_edit_field",
  "video_edit",
] as const;

export type VideoActionKey = (typeof VIDEO_ACTION_KEYS)[number];

/** Actions that must come from the current video control card. Retry and cancel
 * notification buttons are also rendered in standalone messages. */
export const VIDEO_CARD_ACTION_KEYS: readonly VideoActionKey[] = [
  "video_schedule_confirm",
  "video_schedule",
  "video_common",
  "video_individual",
  "video_now",
  "video_now_confirm",
  "video_cancel_ask",
  "video_remove_ask",
  "video_cancel",
  "video_time",
  "video_sched_pick",
  "video_sched_manual",
  "video_remove",
  "video_edit_menu",
  "video_edit_field",
  "video_edit",
];
