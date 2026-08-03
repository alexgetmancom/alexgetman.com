import type { UnsafeBackendDb } from "../../src/db/client.js";
import { videoDrafts, videoTargets } from "../../src/db/schema.js";

export type PublishedVideoOptions = {
  label?: string;
  target: "youtube_shorts" | "instagram_reels";
  publishedAt: string;
  /** Defaults to publishedAt; pass explicitly when a test needs createdAt/updatedAt to diverge. */
  updatedAt?: string;
  externalId?: string;
  deliveryProvider?: string;
  providerAccountId?: string;
  providerPostId?: string;
  locale?: "ru" | "en";
};

/** Inserts a published video draft with one target, the shape every analytics test needs. */
export function insertPublishedVideo(backendDb: UnsafeBackendDb, options: PublishedVideoOptions): { draftId: number; targetId: number } {
  const updatedAt = options.updatedAt ?? options.publishedAt;
  const draft = backendDb.db
    .insert(videoDrafts)
    .values({
      actorId: 1,
      locale: options.locale ?? "ru",
      assetKey: "asset",
      label: options.label ?? "Video",
      status: "published",
      createdAt: options.publishedAt,
      updatedAt,
    })
    .returning({ id: videoDrafts.id })
    .get();
  if (!draft) throw new Error("video draft missing");
  const target = backendDb.db
    .insert(videoTargets)
    .values({
      videoDraftId: draft.id,
      target: options.target,
      metadataJson: {},
      status: "published",
      publishedAt: options.publishedAt,
      createdAt: options.publishedAt,
      updatedAt,
      ...(options.externalId ? { externalId: options.externalId } : {}),
      ...(options.deliveryProvider ? { deliveryProvider: options.deliveryProvider } : {}),
      ...(options.providerAccountId ? { providerAccountId: options.providerAccountId } : {}),
      ...(options.providerPostId ? { providerPostId: options.providerPostId } : {}),
    })
    .returning({ id: videoTargets.id })
    .get();
  if (!target) throw new Error("video target missing");
  return { draftId: draft.id, targetId: target.id };
}
