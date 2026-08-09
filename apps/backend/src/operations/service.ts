import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { commandCenterAttention, commandCenterFingerprint, commandCenterPayload, postDebugPayload } from "./command-center.js";
import { type CommandAction, runOperationCommand } from "./commands.js";

import {
  dashboardPipelineHistoryPayload,
  type PipelineReadModelOptions,
  pipelineOverviewPayload,
  pipelineStatusPayload,
} from "./read-model.js";

function buildOperationsService(backendDb: BackendDb, config: BackendConfig) {
  return {
    dashboard: () => commandCenterPayload(config, backendDb),
    attention: () => commandCenterAttention(config, backendDb),
    fingerprint: () => commandCenterFingerprint(backendDb),
    pipeline: (weekOffset = 0, periodDays = 7, comparisonOffset = 0, offsetDays?: number, options: PipelineReadModelOptions = {}) =>
      pipelineStatusPayload(config, backendDb, weekOffset, periodDays, comparisonOffset, offsetDays, options),
    pipelineOverview: (weekOffset = 0, periodDays = 7, comparisonOffset = 0, offsetDays?: number, options: PipelineReadModelOptions = {}) =>
      pipelineOverviewPayload(config, backendDb, weekOffset, periodDays, comparisonOffset, offsetDays, options),
    dashboardPipelineHistory: (periodDays: number, offsetDays: number) =>
      dashboardPipelineHistoryPayload(config, backendDb, periodDays, offsetDays),
    postDebug: (ref: string) => postDebugPayload(backendDb, ref),
    command: (input: CommandAction, fetchImpl?: typeof fetch) => runOperationCommand(backendDb, input, config, fetchImpl),
  };
}

type OperationsService = ReturnType<typeof buildOperationsService>;
const operationsInstances = new WeakMap<BackendDb, { config: BackendConfig; service: OperationsService }>();

/** Operations boundary for Command Center and authenticated API controllers. */
export function createOperationsService(backendDb: BackendDb, config: BackendConfig): OperationsService {
  const cached = operationsInstances.get(backendDb);
  if (cached?.config === config) return cached.service;
  const service = buildOperationsService(backendDb, config);
  operationsInstances.set(backendDb, { config, service });
  return service;
}
