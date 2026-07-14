import type { JsonValue } from "../../db/schema.js";
import type { MetricTask } from "../schedule.js";

export type MetricResult = { metrics: Record<string, number>; source: string; raw: JsonValue; url?: string };
export type MetricCollector = (task: MetricTask) => Promise<MetricResult>;
