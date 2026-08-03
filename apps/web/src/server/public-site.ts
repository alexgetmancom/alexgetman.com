import { type FeedItem, loadPublicSiteFeed, loadPublicSiteItem } from "../../../backend/src/public/site-read-model.js";
import { getRuntime } from "./runtime.js";

export type { FeedItem };

/** Web adapter for the backend-owned published-site read model. */
export function loadFeedItems(): FeedItem[] {
  return loadPublicSiteFeed(getRuntime().backendDb);
}

/** A post page knows its id, so it has no reason to scan the whole archive.
 * `post_id` is the primary key of `publications`, so the feed holds at most one
 * item per id and this returns the same answer `.find()` did. */
export function findFeedItem(postId: string | number | undefined): FeedItem | undefined {
  const id = Number(postId);
  return Number.isFinite(id) ? loadPublicSiteItem(getRuntime().backendDb, id) : undefined;
}
