import type { BackendConfig } from "../foundation/config.js";
import type { DataDirectoryCheck } from "../foundation/runtime/data-dirs.js";

type DoctorConfig = Pick<
  BackendConfig,
  | "COMMAND_CENTER_TOKEN"
  | "controllerBotToken"
  | "YOUTUBE_RU_REFRESH_TOKEN"
  | "INSTAGRAM_RU_ACCESS_TOKEN"
  | "INSTAGRAM_RU_USER_ID"
  | "MCP_STUDIO_TOKEN"
  | "MCP_STUDIO_ACTOR_ID"
  | "studio"
>;

/** Computes deployment checks without touching the database or filesystem. */
export function doctorChecks(config: DoctorConfig, dataDirectories: DataDirectoryCheck[]) {
  const requiredChecks = {
    telegramBot: Boolean(config.controllerBotToken),
    youtube: !config.studio.modules.youtube || Boolean(config.YOUTUBE_RU_REFRESH_TOKEN),
    instagram: !config.studio.modules.instagram || Boolean(config.INSTAGRAM_RU_ACCESS_TOKEN && config.INSTAGRAM_RU_USER_ID),
    dataDirectoriesWritable: dataDirectories.every((check) => check.writable),
  };
  const checks = {
    ...requiredChecks,
    commandCenterTokenConfigured: Boolean(config.COMMAND_CENTER_TOKEN),
    // A Studio operated from its own machine reaches this deployment over MCP
    // only, and both halves must be present: the token authorizes nothing
    // without the actor it resolves to, and work belongs to that actor.
    studioTransportConfigured: Boolean(config.MCP_STUDIO_TOKEN && config.MCP_STUDIO_ACTOR_ID),
  };
  return { requiredChecks, checks };
}
