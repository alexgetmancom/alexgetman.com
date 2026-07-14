import { and, inArray, isNull, sql } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { credentialChecks, postEvents, workerState } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { capabilityReport } from "./capabilities.js";

/** Transport-neutral health snapshot for operators, APIs and future automation. */
export function healthReport(config: BackendConfig, backendDb: BackendDb) {
  const credentials = backendDb.db.select().from(credentialChecks).all();
  const workers = backendDb.db.select().from(workerState).all();
  const [pending] = backendDb.db
    .select({ count: sql<number>`count(*)` })
    .from(postEvents)
    .where(and(inArray(postEvents.severity, ["warn", "error"]), isNull(postEvents.ackedAt)))
    .all();
  const capabilities = capabilityReport(config);
  const credentialsOk = credentials.every((check) => check.status === "ok");
  const workersOk = workers.every((worker) => worker.stateJson.ok !== false);
  const capabilitiesOk = capabilities.every((capability) => capability.status === "ready");
  return {
    ok: credentialsOk && workersOk && capabilitiesOk,
    generatedAt: new Date().toISOString(),
    capabilities,
    credentials,
    workers: workers.map((worker) => ({ name: worker.name, state: worker.stateJson, updatedAt: worker.updatedAt })),
    pendingAlerts: Number(pending?.count ?? 0),
  };
}
