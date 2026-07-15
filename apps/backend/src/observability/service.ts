import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { capabilityReport } from "./capabilities.js";
import { runObservabilityCycle } from "./cycle.js";
import { healthReport } from "./health.js";

/**
 * Read/run boundary for technical health. Operations can consume these reports,
 * but it does not own credential probes, alerts or worker-health semantics.
 */
export function observabilityService(backendDb: BackendDb, config: BackendConfig) {
  return {
    health: () => healthReport(config, backendDb),
    capabilities: () => capabilityReport(config),
    run: () => runObservabilityCycle(config, backendDb),
  };
}
