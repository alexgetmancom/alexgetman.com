import { type FeedItem, loadPublicSiteFeed } from "../../../backend/src/public/site-read-model.js";
import { getRuntime } from "./runtime.js";

export type { FeedItem };

/** Web adapter for the backend-owned published-site read model. */
export function loadFeedItems(): FeedItem[] {
  return loadPublicSiteFeed(getRuntime().backendDb);
}
