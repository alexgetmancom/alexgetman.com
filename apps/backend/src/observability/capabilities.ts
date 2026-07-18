import type { BackendConfig } from "../foundation/config.js";
import { videoDeliveryRoute } from "../publishing/delivery-provider.js";
import { PLATFORM_PROFILES } from "../publishing/platform-profiles.js";

type CapabilityStatus = "ready" | "missing";
type CapabilityReportEntry = { target: string; required: readonly string[]; missing: string[]; status: CapabilityStatus };

const serviceRequirements: Record<string, readonly string[]> = {
  controller_bot: ["CONTROLLER_BOT_TOKEN", "ADMIN_IDS"],
  youtube_shorts: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
  instagram_reels: ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"],
};

/** Read-only readiness report shared by diagnostics, observability and future agents. */
export function capabilityReport(config: BackendConfig): CapabilityReportEntry[] {
  const requirements = new Map<string, readonly string[]>(Object.entries(serviceRequirements));
  if (videoDeliveryRoute(config, "instagram_reels").provider === "zernio") requirements.set("instagram_reels", ["ZERNIO_API_KEY"]);
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http")
    requirements.set("media_processor", ["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]);
  for (const profile of Object.values(PLATFORM_PROFILES))
    if (profile.requirements.length) requirements.set(profile.id, profile.requirements);
  const values = config as unknown as Record<string, unknown>;
  return [...requirements.entries()].map(([target, required]) => {
    const missing = required.filter((name) => (name === "ADMIN_IDS" ? config.ADMIN_IDS.length === 0 : !values[name]));
    return { target, required, missing: [...missing], status: missing.length ? "missing" : "ready" };
  });
}

/** Single policy gate for every interface, collector and delivery adapter.
 * A disabled integration must be reported as unavailable, never probed. */
export function isCapabilityReady(config: BackendConfig, target: string): boolean {
  return capabilityReport(config).find((entry) => entry.target === target)?.status !== "missing";
}
