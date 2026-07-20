import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { type AlertPort, deliverPendingAlerts } from "./alerts.js";
import { updateCredentialChecks } from "./credentials.js";
import { recordPublicationFailures } from "./failures.js";

const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** A steady climb in rss/heapUsed across cycles (rather than the usual GC
 * sawtooth) is the signal to reach for `bun --inspect` and a heap snapshot. */
function logMemoryUsage(): void {
  const memory = process.memoryUsage();
  log("info", "process memory usage", {
    rssMb: toMb(memory.rss),
    heapUsedMb: toMb(memory.heapUsed),
    heapTotalMb: toMb(memory.heapTotal),
    externalMb: toMb(memory.external),
  });
}

/** Runs independent probes, turns durable events into alerts, and records health. */
export async function runObservabilityCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  alertsPort: AlertPort = {},
): Promise<{ alerts: number; credentials: number }> {
  logMemoryUsage();
  const credentials = updateCredentialChecks(config, backendDb);
  recordPublicationFailures(config, backendDb);
  const alerts = await deliverPendingAlerts(config, backendDb, alertsPort);
  recordWorkerState(backendDb, "observability", { alerts, credentials });
  return { alerts, credentials };
}
