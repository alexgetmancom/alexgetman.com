import type { BackendConfig } from "../config.js";
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
  for (const profile of Object.values(PLATFORM_PROFILES))
    if (profile.requirements.length) requirements.set(profile.id, profile.requirements);
  const values = config as unknown as Record<string, unknown>;
  return [...requirements.entries()].map(([target, required]) => {
    const missing = required.filter((name) => (name === "ADMIN_IDS" ? config.ADMIN_IDS.length === 0 : !values[name]));
    return { target, required, missing: [...missing], status: missing.length ? "missing" : "ready" };
  });
}
