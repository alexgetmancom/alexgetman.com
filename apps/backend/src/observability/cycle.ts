import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { type AlertPort, deliverPendingAlerts } from "./alerts.js";
import { updateCredentialChecks } from "./credentials.js";
import { recordPublicationFailures } from "./failures.js";

/** Runs independent probes, turns durable events into alerts, and records health. */
export async function runObservabilityCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  alertsPort: AlertPort = {},
): Promise<{ alerts: number; credentials: number }> {
  const credentials = updateCredentialChecks(config, backendDb);
  recordPublicationFailures(config, backendDb);
  const alerts = await deliverPendingAlerts(config, backendDb, alertsPort);
  recordWorkerState(backendDb, "observability", { alerts, credentials });
  return { alerts, credentials };
}
