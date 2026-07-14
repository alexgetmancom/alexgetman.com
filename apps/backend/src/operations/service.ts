import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { type CommandAction, runCommandAction } from "./actions.js";
import { commandCenterPayload, postDebugPayload } from "./command-center.js";

export type { CommandAction } from "./actions.js";

/** Operations boundary for Command Center and authenticated API controllers. */
export function operationsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard: () => commandCenterPayload(config, backendDb),
    postDebug: (ref: string) => postDebugPayload(backendDb, ref),
    command: (input: CommandAction, fetchImpl?: typeof fetch) => runCommandAction(backendDb, input, config, fetchImpl),
  };
}
