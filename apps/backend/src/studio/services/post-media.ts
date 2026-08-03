import { listStudioMediaAssets, mediaItemsFromAssets, requireStudioMediaAssets } from "../../content/assets.js";
import type { BackendDb } from "../../db/client.js";
import { recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { accessibleStudioActorIds } from "../access.js";
import { draftMedia, requireOwnedDraft } from "./post-access.js";

/** Media commands kept behind the public post facade. */
export function postMediaService(backendDb: BackendDb, config: BackendConfig) {
  return {
    mediaAssets(actorId: number, limit = 50) {
      return listStudioMediaAssets(backendDb, actorId, limit, accessibleStudioActorIds(config, actorId));
    },

    attachMediaAssets(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[], replace = false): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const assets = mediaItemsFromAssets(
        requireStudioMediaAssets(backendDb, actorId, assetIds, accessibleStudioActorIds(config, actorId)),
      );
      const key = locale === "ru" ? "mediaRuJson" : "mediaEnJson";
      const current = replace ? [] : draftMedia(draft, locale);
      backendDb.drafts.update(draftId, {
        [key]: JSON.stringify([...current, ...assets]),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_attached",
        severity: "info",
        message: `Draft #${draftId} media attached`,
        details: { locale, asset_ids: assetIds, replace },
      });
    },

    removeMedia(actorId: number, draftId: number, locale: "ru" | "en", assetIds: number[]): void {
      const draft = requireOwnedDraft(backendDb, config, actorId, draftId);
      const current = draftMedia(draft, locale);
      const removed = new Set(assetIds);
      const media = current.filter((item) => !removed.has(Number(item.asset_id)));
      backendDb.drafts.update(draftId, {
        [locale === "ru" ? "mediaRuJson" : "mediaEnJson"]: JSON.stringify(media),
        updatedAt: backendDb.clock.now().toISOString(),
      });
      backendDb.storyCards.queue(draftId);
      recordDomainEvent(backendDb.events, {
        ref: `draft:${draftId}`,
        type: "content.draft.media_removed",
        severity: "info",
        message: `Draft #${draftId} media removed`,
        details: { locale, asset_ids: assetIds },
      });
    },
  };
}
