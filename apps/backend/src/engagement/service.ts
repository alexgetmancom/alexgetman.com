import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { trackUsageSync } from "../observability/usage.js";
import { clientIpHash } from "./identity.js";
import { metricsSummary, recordPageview } from "./pageviews.js";
import { allowPublicRequest } from "./rate-limit.js";

/** Public pageview recording and its rate limit. */
export function engagementService(backendDb: BackendDb, config: BackendConfig) {
  const clientKey = (request: Request) => clientIpHash(request, config);
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
        recordPageview(backendDb, path, config.TIMEZONE);
        return true;
      });
    },
    metrics: () => metricsSummary(backendDb, config.TIMEZONE),
  };
}
