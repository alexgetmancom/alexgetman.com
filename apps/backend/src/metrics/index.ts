import { and, eq } from "drizzle-orm";
import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { type JsonValue, postTargets } from "../db/schema.js";
import { recordWorkerState } from "../services/workerState.js";
import { createMetricCollectors, type MetricCollector } from "./collectors.js";
import { pruneMetricSamples, upsertMetricError, upsertMetrics } from "./repository.js";
import { dueMetricTasks, ensureMetricSchedule, finishMetricTask } from "./schedule.js";

export async function runMetricsCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  collectors: Record<string, MetricCollector> = createMetricCollectors(config),
): Promise<number> {
  ensureMetricSchedule(backendDb, Object.keys(collectors));
  const tasks = dueMetricTasks(backendDb, config);
  for (const task of tasks) {
    const collector = collectors[task.target];
    if (!collector) continue;
    try {
      const result = await collector(task);
      backendDb.db.transaction((tx) => {
        upsertMetrics(backendDb, task.postKey, task.target, result.metrics, result.source, result.raw);
        if (result.url)
          tx.update(postTargets)
            .set({ url: result.url, updatedAt: new Date().toISOString() })
            .where(and(eq(postTargets.postKey, task.postKey), eq(postTargets.target, task.target)))
            .run();
        finishMetricTask(backendDb, task, null);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backendDb.db.transaction(() => {
        upsertMetricError(backendDb, task.postKey, task.target, `${task.target}_metrics`, message, {
          external_id: task.externalId,
        } as JsonValue);
        finishMetricTask(backendDb, task, message);
      });
    }
  }

  try {
    pruneMetricSamples(backendDb, 7);
  } catch (error) {
    console.error("Failed to prune old metric samples:", error);
  }

  recordWorkerState(backendDb, "metrics", { checked: tasks.length });
  return tasks.length;
}
