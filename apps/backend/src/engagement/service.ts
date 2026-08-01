import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { trackUsageSync } from "../observability/usage.js";
import { clientIpHash } from "./identity.js";
import { batchLikes, likesInfo, toggleLike } from "./likes.js";
import { metricsSummary, recordPageview } from "./pageviews.js";
import { allowPublicRequest } from "./rate-limit.js";

/** Public engagement use cases: pageviews, reactions and their rate limits. */
export function engagementService(backendDb: BackendDb, config: BackendConfig) {
  const clientKey = (request: Request) => clientIpHash(request, config);
  const allowLikes = (request: Request) =>
    allowPublicRequest(`likes:${clientKey(request)}`, config.PUBLIC_RATE_LIMIT_LIKES, config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS);
  return {
    clientKey,
    recordPageview(request: Request, path: string): boolean {
      const allowed = allowPublicRequest(
        `pageview:${clientKey(request)}`,
        config.PUBLIC_RATE_LIMIT_PAGEVIEWS,
        config.PUBLIC_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!allowed.allowed) return false;
      return trackUsageSync(backendDb, "engagement.pageview.record", () => {
        recordPageview(backendDb, path);
        return true;
      });
    },
    metrics: () => metricsSummary(backendDb),
    allowLikes,
    likes: (request: Request, postId: string) =>
      trackUsageSync(backendDb, "engagement.likes.lookup", () => likesInfo(backendDb, postId, clientKey(request))),
    likesBatch: (request: Request, postIds: string[]) =>
      trackUsageSync(backendDb, "engagement.likes.batch", () => batchLikes(backendDb, postIds, clientKey(request))),
    toggleLike: (request: Request, postId: string) =>
      trackUsageSync(backendDb, "engagement.likes.toggle", () => toggleLike(backendDb, postId, clientKey(request))),
  };
}
