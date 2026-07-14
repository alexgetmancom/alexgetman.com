import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { commandCenterPayload, postDebugPayload } from "./command-center.js";
import { runOperationCommand } from "./commands.js";
import type { OperationsCommand } from "./contracts.js";

/** Operations boundary for Command Center and authenticated API controllers. */
export function operationsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard: () => commandCenterPayload(config, backendDb),
    postDebug: (ref: string) => postDebugPayload(backendDb, ref),
    command: (input: OperationsCommand, fetchImpl?: typeof fetch) => runOperationCommand(backendDb, input, config, fetchImpl),
  };
}

export type OperationsService = ReturnType<typeof operationsService>;
