import { listChannels } from "../channels/registry.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { instagramCredentialsForLocale } from "../foundation/external/instagram.js";
import { PLATFORM_PROFILES } from "../publishing/platform-profiles.js";

type CapabilityStatus = "ready" | "missing";
type CapabilityReportEntry = { target: string; required: readonly string[]; missing: string[]; status: CapabilityStatus };

const serviceRequirements: Record<string, readonly string[]> = {
  controller_bot: ["CONTROLLER_BOT_TOKEN", "CONTROLLER_ADMIN_IDS"],
  youtube_shorts: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"],
  instagram_reels: ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"],
};

/** Read-only readiness report shared by diagnostics, observability and future agents. */
export function capabilityReport(config: BackendConfig, backendDb?: BackendDb): CapabilityReportEntry[] {
  const requirements = backendDb ? registeredRequirements(config, backendDb) : capabilityRequirements(config);
  const values = config as unknown as Record<string, unknown>;
  return [...requirements.entries()].map(([target, required]) => {
    const missing =
      (target.startsWith("instagram_stories") || target.startsWith("instagram_reels")) && !required.includes("ZERNIO_API_KEY")
        ? missingInstagramStoryCredentials(config, target)
        : required.filter((name) => (name === "CONTROLLER_ADMIN_IDS" ? config.CONTROLLER_ADMIN_IDS.length === 0 : !values[name]));
    return { target, required, missing: [...missing], status: missing.length ? "missing" : "ready" };
  });
}

function missingInstagramStoryCredentials(config: BackendConfig, target: string): string[] {
  const locale = target === "instagram_stories_ru" || target === "instagram_reels" ? "ru" : "en";
  const credentials = instagramCredentialsForLocale(config, locale, "shared");
  if (credentials.accessToken && credentials.userId) return [];
  return locale === "ru"
    ? ["INSTAGRAM_RU_ACCESS_TOKEN", "INSTAGRAM_RU_USER_ID"].filter((name) => !(config as unknown as Record<string, unknown>)[name])
    : ["INSTAGRAM_EN_ACCESS_TOKEN", "INSTAGRAM_EN_USER_ID"].filter((name) => !(config as unknown as Record<string, unknown>)[name]);
}

function capabilityRequirements(config: BackendConfig): Map<string, readonly string[]> {
  const requirements = new Map<string, readonly string[]>(Object.entries(serviceRequirements));
  if (config.YOUTUBE_EN_CLIENT_ID || config.YOUTUBE_EN_CLIENT_SECRET || config.YOUTUBE_EN_REFRESH_TOKEN)
    requirements.set("youtube_shorts_en", ["YOUTUBE_EN_CLIENT_ID", "YOUTUBE_EN_CLIENT_SECRET", "YOUTUBE_EN_REFRESH_TOKEN"]);
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http")
    requirements.set("media_processor", ["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]);
  for (const profile of Object.values(PLATFORM_PROFILES))
    if (profile.requirements.length) requirements.set(profile.id, profile.requirements);
  return requirements;
}

/**
 * The channel registry is the deployment's source of truth. A
 * capability for an account that this Studio never connected is not an
 * actionable health failure, even when the shared image knows its env names.
 */
function registeredRequirements(config: BackendConfig, backendDb: BackendDb): Map<string, readonly string[]> {
  const requirements = new Map<string, readonly string[]>([["controller_bot", serviceRequirements.controller_bot ?? []]]);
  for (const channel of listChannels(backendDb)) {
    if (channel.targetId) requirements.set(channel.targetId, PLATFORM_PROFILES[channel.targetId]?.requirements ?? []);
    if (channel.platform === "youtube") {
      const target = channel.locale === "en" ? "youtube_shorts_en" : "youtube_shorts";
      requirements.set(target, videoTargetRequirements(target, channel.provider));
    }
    if (channel.platform === "instagram") {
      const target = channel.locale === "en" ? "instagram_reels_en" : "instagram_reels";
      requirements.set(target, videoTargetRequirements(target, channel.provider));
    }
  }
  if (config.MEDIA_PROCESSOR_PROVIDER === "remote_http")
    requirements.set("media_processor", ["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]);
  return requirements;
}

function videoTargetRequirements(target: string, provider: string): readonly string[] {
  if (provider === "zernio") return ["ZERNIO_API_KEY"];
  if (target === "youtube_shorts") return ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"];
  if (target === "youtube_shorts_en") return ["YOUTUBE_EN_CLIENT_ID", "YOUTUBE_EN_CLIENT_SECRET", "YOUTUBE_EN_REFRESH_TOKEN"];
  return target === "instagram_reels"
    ? ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_USER_ID"]
    : ["INSTAGRAM_EN_ACCESS_TOKEN", "INSTAGRAM_EN_USER_ID"];
}

/** Single policy gate for every interface, collector and delivery adapter.
 * A disabled integration must be reported as unavailable, never probed. */
export function isCapabilityReady(config: BackendConfig, target: string): boolean {
  return capabilityReport(config).find((entry) => entry.target === target)?.status !== "missing";
}
