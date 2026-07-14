import type { BackendDb } from "../db/client.js";
import { credentialChecks } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { capabilityReport } from "./capabilities.js";

/** Persists the current deployment capability probe independently from alerting. */
export function updateCredentialChecks(config: BackendConfig, backendDb: BackendDb): number {
  const now = new Date().toISOString();
  const report = capabilityReport(config);
  for (const { target, required, missing, status } of report) {
    const nextCheckAt = new Date(Date.now() + 3_600_000).toISOString();
    backendDb.db
      .insert(credentialChecks)
      .values({
        target,
        status,
        requiredEnvJson: JSON.stringify(required),
        missingEnvJson: JSON.stringify(missing),
        lastCheckedAt: now,
        nextCheckAt,
        detailsJson: "{}",
      })
      .onConflictDoUpdate({
        target: credentialChecks.target,
        set: {
          status,
          requiredEnvJson: JSON.stringify(required),
          missingEnvJson: JSON.stringify(missing),
          lastCheckedAt: now,
          nextCheckAt,
          lastError: null,
        },
      })
      .run();
  }
  return report.length;
}
