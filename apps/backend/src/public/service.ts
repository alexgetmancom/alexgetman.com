import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { batchLikes, clientIpHash, likesInfo, metricsSummary, recordPageview, toggleLike } from "./engagement.js";
import { allowPublicRequest } from "./rate-limit.js";

/** Public HTTP use cases. Controllers receive this contract instead of table-facing helpers. */
export function publicService(backendDb: BackendDb, config: BackendConfig) {
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
      recordPageview(backendDb, config, path);
      return true;
    },
    metrics: () => metricsSummary(backendDb),
    allowLikes,
    likes: (request: Request, postId: string) => likesInfo(backendDb, postId, clientKey(request)),
    likesBatch: (request: Request, postIds: string[]) => batchLikes(backendDb, postIds, clientKey(request)),
    toggleLike: (request: Request, postId: string) => toggleLike(backendDb, postId, clientKey(request)),
  };
}

export type PublicService = ReturnType<typeof publicService>;
