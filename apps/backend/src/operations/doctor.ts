import type { BackendConfig } from "../foundation/config.js";
import type { DataDirectoryCheck } from "../foundation/runtime/data-dirs.js";
import type { MediaBackupStatus } from "./media-backup.js";

type DoctorConfig = Pick<BackendConfig, "COMMAND_CENTER_TOKEN" | "controllerBotToken" | "MCP_STUDIO_TOKEN" | "MCP_STUDIO_ACTOR_ID">;

/** Computes deployment checks without touching the database or filesystem. */
export function doctorChecks(config: DoctorConfig, dataDirectories: DataDirectoryCheck[], mediaBackup: MediaBackupStatus) {
  const requiredChecks = {
    dataDirectoriesWritable: dataDirectories.every((check) => check.writable),
    // The database leaves nightly over Telegram; media is far too large for
    // that and only ever existed on the volume. A deployment whose media has
    // no off-volume copy is one `docker volume rm` from losing every video,
    // poster and site asset it has ever published, and nothing else says so.
    mediaBackedUp: mediaBackup.ok,
  };
  const checks = {
    ...requiredChecks,
    telegramBot: Boolean(config.controllerBotToken),
    commandCenterTokenConfigured: Boolean(config.COMMAND_CENTER_TOKEN),
    // A Studio operated from its own machine reaches this deployment over MCP
    // only, and both halves must be present: the token authorizes nothing
    // without the actor it resolves to, and work belongs to that actor.
    studioTransportConfigured: Boolean(config.MCP_STUDIO_TOKEN && config.MCP_STUDIO_ACTOR_ID),
  };
  return { requiredChecks, checks };
}
