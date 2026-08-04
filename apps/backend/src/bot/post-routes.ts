import type { PUBLICATION_ACTIONS } from "./session-fsm.js";

/** Canonical action names emitted by the text-post card and scheduling screens. */
export type PostActionKey = (typeof PUBLICATION_ACTIONS.post)[number];

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
