import { and, eq } from "drizzle-orm";
import type { BackendDb } from "../../db/client.js";
import { type JsonValue, postTargets } from "../../db/schema.js";
import type { BackendConfig } from "../../foundation/config.js";
import { recordWorkerState } from "../../foundation/runtime/worker-state.js";
import { platformAnalyticsProfile } from "../../publishing/platform-profiles.js";
import { upsertMetricError, upsertMetrics } from "../snapshots/metric-repository.js";
import { isTerminalMetricError } from "./collectors/errors.js";
import { createMetricCollectors, SUPPORTED_METRIC_TARGETS } from "./collectors/index.js";
import type { MetricCollector } from "./collectors/types.js";
import {
  dueMetricTasks,
  ensureMetricSchedule,
  finishMetricTask,
  freezeDisabledMetricSchedules,
  freezeUnsupportedMetricSchedules,
} from "./metric-schedule.js";

export async function runMetricsCycle(
  config: BackendConfig,
  backendDb: BackendDb,
  collectors: Record<string, MetricCollector> = createMetricCollectors(config),
): Promise<number> {
  // One list drives creation, retirement and claiming. Deriving them separately let a
  // target be collected but never scheduled, or scheduled but never collected.
  const collectableTargets = Object.keys(collectors).filter((target) => platformAnalyticsProfile(target).enabled);
  ensureMetricSchedule(backendDb, collectableTargets);
  freezeUnsupportedMetricSchedules(backendDb, SUPPORTED_METRIC_TARGETS);
  freezeDisabledMetricSchedules(backendDb, [...(config.ENABLE_X_METRICS ? [] : ["x", "twitter"])]);
  const tasks = dueMetricTasks(backendDb, config, collectableTargets);
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
        finishMetricTask(backendDb, task, message, isTerminalMetricError(error));
      });
    }
  }

  recordWorkerState(backendDb, "metrics", { checked: tasks.length });
  return tasks.length;
}
