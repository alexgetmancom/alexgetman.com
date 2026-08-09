import type { BackendConfig } from "../foundation/config.js";
import type { DataDirectoryCheck } from "../foundation/runtime/data-dirs.js";

type DoctorConfig = Pick<
  BackendConfig,
  "COMMAND_CENTER_TOKEN" | "controllerBotToken" | "YOUTUBE_REFRESH_TOKEN" | "INSTAGRAM_ACCESS_TOKEN" | "INSTAGRAM_USER_ID" | "studio"
>;

/** Computes deployment checks without touching the database or filesystem. */
export function doctorChecks(config: DoctorConfig, dataDirectories: DataDirectoryCheck[]) {
  const requiredChecks = {
    telegramBot: Boolean(config.controllerBotToken),
    youtube: !config.studio.modules.youtube || Boolean(config.YOUTUBE_REFRESH_TOKEN),
    instagram: !config.studio.modules.instagram || Boolean(config.INSTAGRAM_ACCESS_TOKEN && config.INSTAGRAM_USER_ID),
    dataDirectoriesWritable: dataDirectories.every((check) => check.writable),
  };
  const checks = {
    ...requiredChecks,
    commandCenterTokenConfigured: Boolean(config.COMMAND_CENTER_TOKEN),
  };
  return { requiredChecks, checks };
}
