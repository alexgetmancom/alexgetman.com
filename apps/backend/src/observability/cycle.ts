import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { type AlertPort, deliverPendingAlerts } from "./alerts.js";
import { updateCredentialChecks } from "./credentials.js";
import { recordPublicationFailures } from "./failures.js";
import { type MemorySnapshot, readMemorySnapshot } from "./memory.js";
import { recordMemorySample } from "./memory-history.js";
import { recordMemoryPressure, recordProcessRestart } from "./runtime-health.js";
import { checkTokenHealth } from "./token-health.js";

const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024);

/** A steady climb in rss/heapUsed across cycles (rather than the usual GC
 * sawtooth) is the signal to reach for `bun --inspect` and a heap snapshot. */
function logMemoryUsage(memory: MemorySnapshot): void {
  log("info", "process memory usage", {
    rssMb: toMb(memory.rssBytes),
    heapUsedMb: toMb(memory.heapUsedBytes),
    heapTotalMb: toMb(memory.heapTotalBytes),
    externalMb: toMb(memory.externalBytes),
  });
}

/** The probes are independent by design, so run them that way: the loop runner
 * only catches per tick, which meant a throwing token-health probe silently took
 * failure recording and alert delivery with it on every tick — the observability
 * cycle going blind exactly when something was wrong. */
async function probe(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    log("error", "observability probe failed", { probe: name, error: String(error) });
  }
}

/** Runs independent probes, turns durable events into alerts, and records health. */
export async function runObservabilityCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  alertsPort: AlertPort = {},
): Promise<{ alerts: number; credentials: number }> {
  const memory = readMemorySnapshot();
  logMemoryUsage(memory);
  await probe("memory-sample", () => recordMemorySample(backendDb, memory));
  let credentials = 0;
  let alerts = 0;
  // Ordered before the alert probe on purpose: both record durable events, so
  // running them first lets this same cycle deliver what they found instead of
  // waiting a full interval.
  await probe("runtime-restart", () => void recordProcessRestart(config, backendDb));
  await probe("memory-pressure", () => void recordMemoryPressure(config, backendDb));
  await probe("credentials", () => {
    credentials = updateCredentialChecks(config, backendDb);
  });
  await probe("token-health", async () => void (await checkTokenHealth(config, backendDb)));
  await probe("publication-failures", () => recordPublicationFailures(config, backendDb));
  await probe("alerts", async () => {
    alerts = await deliverPendingAlerts(config, backendDb, alertsPort);
  });
  recordWorkerState(backendDb, "observability", { alerts, credentials });
  return { alerts, credentials };
}
