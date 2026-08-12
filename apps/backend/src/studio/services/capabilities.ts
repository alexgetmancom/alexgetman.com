import { listChannels } from "../../channels/registry.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { capabilityReport } from "../../observability/capabilities.js";
import { PLATFORM_PROFILES } from "../../publishing/platform-profiles.js";
import { VIDEO_TARGET_PLATFORM } from "../../publishing/video-types.js";

/**
 * Safe capability read model for Studio interfaces and AI operators. It reports
 * enabled features and readiness, never configured values or secret names.
 */
export function studioCapabilityService(config: BackendConfig, backendDb?: BackendDb) {
  return {
    report() {
      const readiness = new Map(capabilityReport(config, backendDb).map((entry) => [entry.target, entry]));
      return {
        modules: { ...config.studio.modules },
        platforms: Object.values(PLATFORM_PROFILES)
          .filter((profile) => {
            if (!backendDb) return true;
            const registered = listChannels(backendDb).filter((channel) => channel.targetId);
            return !registered.length || registered.some((channel) => channel.targetId === profile.id);
          })
          .map((profile) => {
            const state = readiness.get(profile.id);
            return {
              id: profile.id,
              label: profile.label,
              locale: profile.locale,
              kind: profile.kind,
              capabilities: profile.capabilities,
              status: state?.status ?? "ready",
              missing: state?.missing.length ?? 0,
            };
          }),
        video: backendDb
          ? listChannels(backendDb)
              .filter((channel) => channel.platform === "youtube" || channel.platform === "instagram")
              .map((channel) => {
                const state = readiness.get(channel.id);
                const target = Object.entries(VIDEO_TARGET_PLATFORM).find(([, platform]) => platform === channel.platform)?.[0];
                return {
                  id: channel.id,
                  target,
                  locale: channel.locale,
                  status: state?.status ?? "missing",
                  missing: state?.missing.length ?? 0,
                };
              })
          : [],
        mediaProcessor: (() => {
          const state = readiness.get("media_processor");
          return { provider: config.MEDIA_PROCESSOR_PROVIDER, status: state?.status ?? "ready", missing: state?.missing.length ?? 0 };
        })(),
      };
    },
  };
}
