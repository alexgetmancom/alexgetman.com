import type { BackendConfig } from "../foundation/config.js";
import type { DataDirectoryCheck } from "../foundation/runtime/data-dirs.js";

type DoctorConfig = Pick<
  BackendConfig,
  | "ENABLE_BOT_POLLING"
  | "TELEGRAM_WEBHOOK_SECRET"
  | "COMMAND_CENTER_TOKEN"
  | "controllerBotToken"
  | "YOUTUBE_REFRESH_TOKEN"
  | "INSTAGRAM_ACCESS_TOKEN"
  | "INSTAGRAM_USER_ID"
  | "studio"
>;

/** Computes deployment checks without touching the database or filesystem. */
export function doctorChecks(config: DoctorConfig, dataDirectories: DataDirectoryCheck[]) {
  const webhookMode = !config.ENABLE_BOT_POLLING;
  const requiredChecks = {
    telegramBot: Boolean(config.controllerBotToken),
    webhookSecretConfigured: !webhookMode || Boolean(config.TELEGRAM_WEBHOOK_SECRET),
    youtube: !config.studio.modules.youtube || Boolean(config.YOUTUBE_REFRESH_TOKEN),
    instagram: !config.studio.modules.instagram || Boolean(config.INSTAGRAM_ACCESS_TOKEN && config.INSTAGRAM_USER_ID),
    dataDirectoriesWritable: dataDirectories.every((check) => check.writable),
  };
  const checks = {
    ...requiredChecks,
    commandCenterTokenConfigured: Boolean(config.COMMAND_CENTER_TOKEN),
    commandCenterTokenSeparated:
      Boolean(config.COMMAND_CENTER_TOKEN) && (config.ENABLE_BOT_POLLING || config.COMMAND_CENTER_TOKEN !== config.TELEGRAM_WEBHOOK_SECRET),
  };
  return { requiredChecks, checks };
}
