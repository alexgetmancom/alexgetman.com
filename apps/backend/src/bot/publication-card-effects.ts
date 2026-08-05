import type { PublicationEffect } from "./effects.js";
import type { PublicationCard } from "./publication-card.js";

/** Turns a rendered publication card into the standard Telegram screen effect. */
export function publicationCardEffect(
  kind: "post" | "video",
  draftId: number,
  preview: PublicationCard,
  effect: { type: "prompt" } | { type?: "screen"; mode?: "edit" | "reply" } = {},
): PublicationEffect[] {
  const card = kind === "post" ? { kind: "post" as const, draftId } : { kind: "video" as const, draftId };
  if (effect.type === "prompt")
    return [
      {
        type: "prompt",
        text: preview.text,
        options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
        card,
      },
    ];
  return [
    {
      type: "screen",
      mode: effect.mode ?? "edit",
      text: preview.text,
      options: { parse_mode: "Markdown", reply_markup: preview.keyboard },
      card,
    },
  ];
}
