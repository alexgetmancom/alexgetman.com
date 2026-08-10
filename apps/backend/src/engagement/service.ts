import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { trackUsageSync } from "../observability/usage.js";
import { clientIpHash } from "./identity.js";
import { metricsSummary, recordPageview } from "./pageviews.js";
import { allowPublicRequest } from "./rate-limit.js";

const PAGEVIEW_RATE_LIMIT = 240;
const PAGEVIEW_RATE_WINDOW_SECONDS = 60;

/** Public pageview recording and its rate limit. */
export function engagementService(backendDb: BackendDb, config: BackendConfig) {
  const clientKey = (request: Request) => clientIpHash(request, config);
  return {
    clientKey,
    recordPageview(request: Request, path: string): boolean {
      const allowed = allowPublicRequest(`pageview:${clientKey(request)}`, PAGEVIEW_RATE_LIMIT, PAGEVIEW_RATE_WINDOW_SECONDS);
      if (!allowed.allowed) return false;
      return trackUsageSync(backendDb, "engagement.pageview.record", () => {
        recordPageview(backendDb, path, config.TIMEZONE);
        return true;
      });
    },
    metrics: () => metricsSummary(backendDb, config.TIMEZONE),
  };
}
