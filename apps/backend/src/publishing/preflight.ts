import { parseArrayValue } from "../content/message.js";
import { platformProfile } from "./platform-profiles.js";
import { parseTargets } from "./targets.js";

type DraftForPreflight = {
  text_ru: string | null;
  media_ru_json: string | null;
  targets_json: string;
};

type PublicationPreflightIssue = {
  target: string;
  locale: "ru";
  limit: number;
  actual: number;
  message: string;
};

/**
 * Checks constraints that must block a plan. Delivery still defensively
 * normalizes legacy payloads, but a new draft must never become a partial
 * publication merely because Telegram cannot accept its media caption.
 */
export function publicationPreflight(draft: DraftForPreflight): PublicationPreflightIssue[] {
  const targets = parseTargets(draft.targets_json);
  const ruMedia = parseArrayValue(draft.media_ru_json);
  const telegramCaptionLimit = platformProfile("telegram")?.limits?.caption;
  if (!targets.telegram || ruMedia.length === 0 || !telegramCaptionLimit) return [];
  const actual = String(draft.text_ru ?? "").length;
  if (actual <= telegramCaptionLimit) return [];
  return [
    {
      target: "telegram",
      locale: "ru",
      limit: telegramCaptionLimit,
      actual,
      message: `Telegram с медиа: ${actual}/${telegramCaptionLimit} символов. Сократите RU-текст или отключите Telegram.`,
    },
  ];
}

export function assertPublicationPreflight(draft: DraftForPreflight): void {
  const issues = publicationPreflight(draft);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));
}
