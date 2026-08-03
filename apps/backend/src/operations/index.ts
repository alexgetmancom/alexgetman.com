/** Public operations facade for CLI and authenticated Command Center adapters. */

export type { CommandCenterAttention } from "./command-center.js";
export { commandActionSchema, runOperationCommand } from "./commands.js";
export type { OperationsCommand } from "./contracts.js";
export { operationsService } from "./service.js";
