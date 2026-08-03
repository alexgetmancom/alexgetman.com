import { and, inArray, isNull, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { credentialChecks, postEvents, workerState } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { workerLiveness } from "../foundation/runtime/worker-state.js";
import { capabilityReport } from "./capabilities.js";

/** Transport-neutral health snapshot for operators, APIs and future automation. */
export function healthReport(config: BackendConfig, backendDb: BackendDb) {
  const capabilities = capabilityReport(config, backendDb);
  const activeCapabilityTargets = new Set(capabilities.map((capability) => capability.target));
  const credentials = backendDb.db
    .select()
    .from(credentialChecks)
    .all()
    .filter((credential) => activeCapabilityTargets.has(credential.target));
  const workers = backendDb.db.select().from(workerState).all();
  const [pending] = backendDb.db
    .select({ count: sql<number>`count(*)` })
    .from(postEvents)
    .where(and(inArray(postEvents.severity, ["warn", "error"]), isNull(postEvents.ackedAt)))
    .all();
  const credentialsOk = credentials.every((check) => check.status === "ready");
  const workersOk = workers.every(
    (worker) =>
      worker.stateJson.ok !== false &&
      worker.stateJson.scheduler_error == null &&
      !workerLiveness(worker.stateJson, worker.updatedAt).stale,
  );
  const capabilitiesOk = capabilities.every((capability) => capability.status === "ready");
  return {
    ok: credentialsOk && workersOk && capabilitiesOk,
    generatedAt: new Date().toISOString(),
    capabilities,
    credentials,
    workers: workers.map((worker) => ({
      name: worker.name,
      state: worker.stateJson,
      updatedAt: worker.updatedAt,
      ...workerLiveness(worker.stateJson, worker.updatedAt),
    })),
    pendingAlerts: Number(pending?.count ?? 0),
  };
}
