import { hasChannelRegistry, listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
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
export function capabilityReport(config: BackendConfig, backendDb?: BackendDb): CapabilityReportEntry[] {
  const allRequirements = capabilityRequirements(config);
  const activeTargets = backendDb ? registeredCapabilityTargets(config, backendDb) : null;
  const requirements = activeTargets ? scopedRequirements(allRequirements, config, activeTargets) : allRequirements;
  const values = config as unknown as Record<string, unknown>;
  return [...requirements.entries()].map(([target, required]) => {
    const missing = required.filter((name) => (name === "ADMIN_IDS" ? config.ADMIN_IDS.length === 0 : !values[name]));
    return { target, required, missing: [...missing], status: missing.length ? "missing" : "ready" };
  });
}

function capabilityRequirements(config: BackendConfig): Map<string, readonly string[]> {
  const requirements = new Map<string, readonly string[]>(Object.entries(serviceRequirements));
  if (config.YOUTUBE_EN_CLIENT_ID || config.YOUTUBE_EN_CLIENT_SECRET || config.YOUTUBE_EN_REFRESH_TOKEN)
    requirements.set("youtube_shorts_en", ["YOUTUBE_EN_CLIENT_ID", "YOUTUBE_EN_CLIENT_SECRET", "YOUTUBE_EN_REFRESH_TOKEN"]);
  if (videoDeliveryRoute(config, "instagram_reels").provider === "zernio") requirements.set("instagram_reels", ["ZERNIO_API_KEY"]);
  if (videoDeliveryRoute(config, "instagram_reels", "en").provider === "zernio") requirements.set("instagram_reels_en", ["ZERNIO_API_KEY"]);
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http")
    requirements.set("media_processor", ["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]);
  for (const profile of Object.values(PLATFORM_PROFILES))
    if (profile.requirements.length) requirements.set(profile.id, profile.requirements);
  return requirements;
}

/**
 * Once the channel registry exists it is the deployment's source of truth. A
 * capability for an account that this Studio never connected is not an
 * actionable health failure, even when the shared image knows its env names.
 * An empty registry retains the legacy/configuration fallback for fresh DBs and
 * fixtures that have not run the bootstrap cycle yet.
 */
function registeredCapabilityTargets(config: BackendConfig, backendDb: BackendDb): Set<string> | null {
  if (!hasChannelRegistry(backendDb)) return null;
  const targets = new Set<string>(["controller_bot"]);
  for (const channel of listChannels(backendDb)) {
    if (channel.targetId) targets.add(channel.targetId);
    if (channel.platform === "youtube") targets.add(channel.locale === "en" ? "youtube_shorts_en" : "youtube_shorts");
    if (channel.platform === "instagram") targets.add(channel.locale === "en" ? "instagram_reels_en" : "instagram_reels");
  }
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http") targets.add("media_processor");
  return targets;
}

function scopedRequirements(
  allRequirements: Map<string, readonly string[]>,
  config: BackendConfig,
  activeTargets: Set<string>,
): Map<string, readonly string[]> {
  const requirements = new Map<string, readonly string[]>();
  for (const target of activeTargets) {
    const required = allRequirements.get(target) ?? videoTargetRequirements(config, target);
    if (required) requirements.set(target, required);
  }
  return requirements;
}

function videoTargetRequirements(config: BackendConfig, target: string): readonly string[] | undefined {
  if (target === "youtube_shorts") return ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"];
  if (target === "youtube_shorts_en") return ["YOUTUBE_EN_CLIENT_ID", "YOUTUBE_EN_CLIENT_SECRET", "YOUTUBE_EN_REFRESH_TOKEN"];
  if (target === "instagram_reels")
    return videoDeliveryRoute(config, "instagram_reels").provider === "zernio"
      ? ["ZERNIO_API_KEY"]
      : ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"];
  if (target === "instagram_reels_en")
    return videoDeliveryRoute(config, "instagram_reels", "en").provider === "zernio"
      ? ["ZERNIO_API_KEY"]
      : ["INSTAGRAM_EN_ACCESS_TOKEN", "INSTAGRAM_EN_USER_ID"];
  return undefined;
}

/** Single policy gate for every interface, collector and delivery adapter.
 * A disabled integration must be reported as unavailable, never probed. */
export function isCapabilityReady(config: BackendConfig, target: string): boolean {
  return capabilityReport(config).find((entry) => entry.target === target)?.status !== "missing";
}
