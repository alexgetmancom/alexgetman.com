/** Callback names emitted by the text-post card and its scheduling screens. */
export const POST_ACTION_KEYS = [
  "toggle",
  "preview",
  "platforms",
  "cycle_mode",
  "cancel_state",
  "edit_ru",
  "edit_en",
  "replace_ru_media",
  "replace_en_media",
  "sources",
  "cancel",
  "cancel_confirm",
  "post_retry",
  "post_retry_notice",
  "publish",
  "story_publish_all",
  "story_publish_site",
  "story_schedule_all",
  "story_schedule_site",
  "threads_chain",
  "publish_confirm",
  "schedule",
  "sched_scope",
  "sched_view",
  "sched_pick",
  "sched_manual_confirm",
  "sched_manual",
] as const;

export type PostActionKey = (typeof POST_ACTION_KEYS)[number];

/** Mutating or navigation actions that must come from the current post card. */
export const POST_CARD_ACTION_KEYS: readonly PostActionKey[] = [
  "toggle",
  "cycle_mode",
  "sources",
  "edit_ru",
  "edit_en",
  "replace_ru_media",
  "replace_en_media",
  "cancel",
  "cancel_confirm",
  "post_retry",
  "publish",
  "publish_confirm",
  "schedule",
  "sched_scope",
  "sched_view",
  "sched_pick",
  "sched_manual",
  "story_publish_all",
  "story_publish_site",
  "story_schedule_all",
  "story_schedule_site",
  "threads_chain",
];

export function callbackAction(data: string): string {
  const separator = data.indexOf(":");
  return separator === -1 ? data : data.slice(0, separator);
}
