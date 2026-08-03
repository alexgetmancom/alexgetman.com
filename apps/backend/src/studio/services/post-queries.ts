import { targetLocale } from "../../botTargets.js";
import { effectivePostTargets } from "../../channels/registry.js";
import { draftLocaleContent } from "../../content/draft-content.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { mediaPolicyForTarget } from "../../publishing/media-policy.js";
import { publicationPreflight } from "../../publishing/preflight.js";
import { parseTargets } from "../../publishing/targets.js";
import { storyCardsForDraft } from "../../story-cards/store.js";
import { accessibleStudioActorIds } from "../access.js";
import { postDeliveryProjections } from "../projections.js";
import { requireOwnedDraft } from "./post-access.js";
import { postProgressState } from "./post-progress.js";

/** Query-side use cases exposed through the Studio post facade. */
export function postQueryService(backendDb: BackendDb, config: BackendConfig) {
  return {
    get(actorId: number, draftId: number) {
      return requireOwnedDraft(backendDb, config, actorId, draftId);
    },

    list(actorId: number, limit = 50) {
      return backendDb.drafts.list(accessibleStudioActorIds(config, actorId), limit);
    },

    validate(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return publicationPreflight({
        ...draft,
        targets_json: JSON.stringify(effectivePostTargets(backendDb, parseTargets(draft.targets_json))),
      });
    },

    preview(actorId: number, draftId: number) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const ruContent = draftLocaleContent(draft, "ru");
      const enContent = draftLocaleContent(draft, "en");
      const storyCards = storyCardsForDraft(backendDb, draftId);
      const storyCardsReady = ["ru", "en"].every((locale) =>
        storyCards.some((card) => card.locale === locale && card.status === "ready" && card.localPath),
      );
      const targets = effectivePostTargets(backendDb, parseTargets(draft.targets_json));
      return {
        id: draft.id,
        status: draft.status,
        locales: [
          { locale: "ru" as const, ...ruContent },
          { locale: "en" as const, ...enContent },
        ],
        targets,
        sources: backendDb.studioPosts.sources(draftId),
        mediaPolicy: Object.entries(targets)
          .filter(([, enabled]) => enabled)
          .map(([target]) => mediaPolicyForTarget(target, targetLocale(target) === "ru" ? ruContent.media : enContent.media)),
        delivery: postDeliveryProjections(draft, storyCardsReady),
        storyCards,
      };
    },

    progress(actorId: number, draftId: number) {
      requireOwnedDraft(backendDb, config, actorId, draftId);
      return postProgressState(backendDb, draftId);
    },

    status(actorId: number, draftId: number) {
      return postProgressState(backendDb, requireOwnedDraft(backendDb, config, actorId, draftId).id);
    },

    history(actorId: number, draftId: number, limit = 50) {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      return backendDb.studioPosts.history(draft.id, draft.post_id, limit);
    },
  };
}
