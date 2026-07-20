import { targetLocale } from "../botTargets.js";
import { parseArrayValue } from "../content/message.js";
import { platformProfile } from "./platform-profiles.js";
import { parseTargets } from "./targets.js";

type DraftForPreflight = {
  text_ru: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  media_ru_json: string | null;
  media_en_json?: string | null;
  targets_json: string;
};

type PublicationPreflightIssue = {
  target: string;
  locale: "ru" | "en";
  limit: number;
  actual: number;
  label: string;
  message: string;
};

/**
 * Checks constraints that must block a plan. Delivery still defensively
 * normalizes legacy payloads, but a new draft must never become a partial
 * publication merely because a selected target cannot accept its media caption.
 */
export function publicationPreflight(draft: DraftForPreflight): PublicationPreflightIssue[] {
  const targets = parseTargets(draft.targets_json);
  const content = {
    ru: { text: String(draft.text_ru ?? ""), media: parseArrayValue(draft.media_ru_json) },
    en: {
      text: String(draft.text_en_approved ?? draft.text_en_machine ?? ""),
      media: parseArrayValue(draft.media_en_json ?? draft.media_ru_json),
    },
  } as const;
  return Object.entries(targets).flatMap(([target, enabled]) => {
    if (!enabled) return [];
    const profile = platformProfile(target);
    const locale = targetLocale(target) ?? "ru";
    const value = content[locale];
    const limit = profile?.limits?.caption;
    if (!limit || value.media.length === 0 || value.text.length <= limit) return [];
    const label = profile?.label ?? target;
    return [
      {
        target,
        locale,
        limit,
        actual: value.text.length,
        label,
        message: `${label} с медиа: ${value.text.length}/${limit} символов. Сократите ${locale.toUpperCase()}-текст или отключите ${label}.`,
      },
    ];
  });
}

export function assertPublicationPreflight(draft: DraftForPreflight): void {
  const issues = publicationPreflight(draft);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));
}
