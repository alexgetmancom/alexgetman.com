import type { InlineKeyboard } from "grammy";
import type { PublicationKind } from "../application/conversation-flow.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { StudioLocale } from "../foundation/locale.js";
import { isVideoPreviewView, videoPreview } from "../interfaces/telegram/video-preview.js";
import type { VideoTarget } from "../publishing/video-types.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import type { PublicationEffect } from "./effects.js";
import { draftPreview, isDraftView } from "./preview.js";

export type PublicationCard = {
  kind: PublicationKind;
  draftId: number;
  text: string;
  keyboard: InlineKeyboard;
};

type PublicationRendererInput = {
  actorId: number;
  publicationId: number;
  locale: StudioLocale;
  view?: string | undefined;
  target?: VideoTarget | undefined;
  revision?: number | null | undefined;
};

export type PublicationRenderer = {
  card(input: PublicationRendererInput): PublicationCard;
};

type PublicationRenderers = Record<PublicationKind, PublicationRenderer>;

export function publicationRenderers(
  backendDb: BackendDb,
  config: BackendConfig,
  services = createStudioServices(backendDb, config),
): PublicationRenderers {
  return {
    post: {
      card: (input) => {
        const view = input.view && isDraftView(input.view) ? input.view : undefined;
        const preview = draftPreview(backendDb, input.publicationId, config, input.locale, view);
        return { kind: "post", draftId: input.publicationId, ...preview };
      },
    },
    video: {
      card: (input) => {
        const timeConfig = services.settings.timeConfig(input.actorId, config);
        const preview = videoPreview(services.videos.preview(input.actorId, input.publicationId), timeConfig, input.locale, {
          view: isVideoPreviewView(input.view) ? input.view : undefined,
          revision: input.revision,
          target: input.target,
        });
        return { kind: "video", draftId: input.publicationId, ...preview };
      },
    },
  };
}

export function publicationCardEffect(
  card: PublicationCard,
  effect: { type: "prompt" } | { type?: "screen"; mode?: "edit" | "reply" } = {},
): PublicationEffect[] {
  const options = { parse_mode: "Markdown", reply_markup: card.keyboard };
  if (effect.type === "prompt") return [{ type: "prompt", text: card.text, options, card: cardRef(card) }];
  return [{ type: "screen", mode: effect.mode ?? "edit", text: card.text, options, card: cardRef(card) }];
}

function cardRef(card: PublicationCard): { kind: "post" | "video"; draftId: number } {
  return { kind: card.kind, draftId: card.draftId };
}

/** The post card as every Telegram path renders it: the same renderer, the same
 * services and the actor's own locale. Three call sites spelled it out and one
 * of them could have drifted on which locale it passed. */
export function postPreviewCard(backendDb: BackendDb, config: BackendConfig, actorId: number, draftId: number) {
  return publicationRenderers(backendDb, config).post.card({
    actorId,
    publicationId: draftId,
    locale: settingsService(backendDb).locale(actorId),
  });
}

/** The same for a video draft. */
export function videoPreviewCard(
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  draftId: number,
  services = createStudioServices(backendDb, config),
) {
  return publicationRenderers(backendDb, config, services).video.card({
    actorId,
    publicationId: draftId,
    locale: settingsService(backendDb).locale(actorId),
  });
}
