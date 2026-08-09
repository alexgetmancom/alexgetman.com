import { targetLocale } from "../botTargets.js";
import { draftLocaleContent } from "../content/draft-content.js";
import { splitText } from "../delivery/social/payload.js";
import { formatPlatformText, platformProfile } from "./platform-profiles.js";
import { assertKnownTargets, parseTargets } from "./targets.js";
import { isThreadsTarget, threadsBody } from "./threads-text.js";

type DraftForPreflight = {
  text_ru: string | null;
  text_en_approved?: string | null;
  text_en_machine?: string | null;
  media_ru_json: string | null;
  media_en_json?: string | null;
  text_ru_entities_json?: string | null;
  text_en_entities_json?: string | null;
  targets_json: string;
  threads_chain_approved?: number | boolean | null;
};

type PublicationPreflightIssue = {
  target: string;
  locale: "ru" | "en";
  limit: number;
  actual: number;
  label: string;
  message: string;
  /** How many Threads posts the text would take if the author waives the rule.
   * Absent on issues that cannot be waived, which is what the bot keys the
   * override button off — a Telegram caption has no chain to fall back to. */
  chainParts?: number;
};

/**
 * Checks constraints that must block a plan. Delivery still defensively
 * validates delivery payloads, but a new draft must never become a partial
 * publication merely because a selected target cannot accept its media caption.
 */
export function publicationPreflight(draft: DraftForPreflight): PublicationPreflightIssue[] {
  const targets = parseTargets(draft.targets_json);
  const content = {
    ru: draftLocaleContent(draft, "ru"),
    en: draftLocaleContent(draft, "en"),
  } as const;
  return Object.entries(targets).flatMap(([target, enabled]) => {
    if (!enabled) return [];
    const profile = platformProfile(target);
    const locale = targetLocale(target) ?? "ru";
    const value = content[locale];
    const label = profile?.label ?? target;
    // Threads is measured on the body it will actually carry: the appended link
    // is part of the budget when it fits, and simply absent when it does not.
    const text = isThreadsTarget(target)
      ? threadsBody(target, value.text, value.entities, { chain: Boolean(draft.threads_chain_approved) }).text
      : formatPlatformText(target, value.text);
    // A caption limit only binds when media is attached; a text limit is the
    // platform's own cap on a post and binds always. Threads has the second kind:
    // it used to be met by splitting into a reply chain, and is now a hard stop,
    // so the draft has to fit before it is planned.
    // A Threads text limit can be waived per draft, because Threads has somewhere
    // to put the overflow: a reply chain. A Telegram caption limit cannot — there
    // is no second message to continue into — so it is never waivable.
    const waivable = isThreadsTarget(target);
    const waived = waivable && Boolean(draft.threads_chain_approved);
    const rules = [
      { limit: profile?.limits?.text, applies: !waived, waivable, message: (l: number) => `${label}: ${text.length}/${l} символов.` },
      {
        limit: profile?.limits?.caption,
        applies: value.media.length > 0,
        waivable: false,
        message: (l: number) => `${label} с медиа: ${text.length}/${l} символов.`,
      },
    ];
    return rules.flatMap((rule) =>
      rule.applies && rule.limit && text.length > rule.limit
        ? [
            {
              target,
              locale,
              limit: rule.limit,
              actual: text.length,
              label,
              message: `${rule.message(rule.limit)} Сократите ${locale.toUpperCase()}-текст или отключите ${label}.`,
              ...(rule.waivable ? { chainParts: splitText(text, rule.limit).length } : {}),
            },
          ]
        : [],
    );
  });
}

export function assertPublicationPreflight(draft: DraftForPreflight): void {
  assertKnownTargets(parseTargets(draft.targets_json));
  const issues = publicationPreflight(draft);
  if (issues.length > 0) throw new Error(issues.map((issue) => issue.message).join(" "));
}
