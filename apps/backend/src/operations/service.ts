import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { commandCenterFingerprint, commandCenterPayload, postDebugPayload } from "./command-center.js";
import { runOperationCommand } from "./commands.js";
import type { OperationsCommand } from "./contracts.js";
import { type PipelineReadModelOptions, pipelineStatusPayload } from "./read-model.js";

/** Operations boundary for Command Center and authenticated API controllers. */
export function operationsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard: () => commandCenterPayload(config, backendDb),
    fingerprint: () => commandCenterFingerprint(backendDb),
    pipeline: (weekOffset = 0, periodDays = 7, comparisonOffset = 0, offsetDays?: number, options: PipelineReadModelOptions = {}) =>
      pipelineStatusPayload(config, backendDb, weekOffset, periodDays, comparisonOffset, offsetDays, options),
    postDebug: (ref: string) => postDebugPayload(backendDb, ref),
    command: (input: OperationsCommand, fetchImpl?: typeof fetch) => runOperationCommand(backendDb, input, config, fetchImpl),
  };
}
