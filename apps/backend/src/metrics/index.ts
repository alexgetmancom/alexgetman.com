import type { BackendConfig } from "../config.js";
import type { BackendDb } from "../db/client.js";
import { recordWorkerState } from "../services/workerState.js";
import { createMetricCollectors, type MetricCollector } from "./collectors.js";
import { upsertMetricError, upsertMetrics } from "./repository.js";
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
      backendDb.sqlite.transaction(() => {
        upsertMetrics(backendDb, task.postKey, task.target, result.metrics, result.source, result.raw);
        if (result.url) backendDb.sqlite.prepare("UPDATE post_targets SET url=?, updated_at=? WHERE post_key=? AND target=?").run(result.url, new Date().toISOString(), task.postKey, task.target);
        finishMetricTask(backendDb, task, null);
      })();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backendDb.sqlite.transaction(() => {
        upsertMetricError(backendDb, task.postKey, task.target, `${task.target}_metrics`, message, { external_id: task.externalId });
        finishMetricTask(backendDb, task, message);
      })();
    }
  }
  recordWorkerState(backendDb, "metrics", { checked: tasks.length });
  return tasks.length;
}
