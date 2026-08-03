import { and, eq, inArray } from "drizzle-orm";
import type { StudioMediaAssetStore } from "../../application/ports.js";
import { studioMediaAssets } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for content-addressed Studio media metadata. */
export function createStudioMediaAssetStore(db: BackendDatabase): StudioMediaAssetStore {
  return {
    findByOwnerHash(actorId, sha256) {
      return (
        db
          .select()
          .from(studioMediaAssets)
          .where(and(eq(studioMediaAssets.actorId, actorId), eq(studioMediaAssets.sha256, sha256)))
          .get() ?? null
      );
    },

    insertIfAbsent(input) {
      return (
        db
          .insert(studioMediaAssets)
          .values(input)
          .onConflictDoNothing({ target: [studioMediaAssets.actorId, studioMediaAssets.sha256] })
          .returning()
          .get() ?? null
      );
    },

    get(id) {
      return db.select().from(studioMediaAssets).where(eq(studioMediaAssets.id, id)).get() ?? null;
    },

    list(actorIds, limit) {
      return db
        .select()
        .from(studioMediaAssets)
        .where(inArray(studioMediaAssets.actorId, actorIds))
        .orderBy(studioMediaAssets.id)
        .limit(limit)
        .all();
    },

    require(actorIds, assetIds) {
      if (assetIds.length === 0) return [];
      const ids = [...new Set(assetIds)];
      const assets = db
        .select()
        .from(studioMediaAssets)
        .where(and(inArray(studioMediaAssets.actorId, actorIds), inArray(studioMediaAssets.id, ids)))
        .all();
      if (assets.length !== ids.length) throw new Error("One or more media assets are not available to this owner.");
      const byId = new Map(assets.map((asset) => [asset.id, asset]));
      return ids.map((id) => byId.get(id)).filter((asset): asset is (typeof assets)[number] => asset != null);
    },
  };
}
