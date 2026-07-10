import { z } from "zod";
import { publicationJobSchema } from "./publication.js";

export const workerLoopStatusSchema = z.object({
  name: z.string(),
  ok: z.boolean(),
  lastRunAt: z.string().nullable().optional(),
  nextRunAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type WorkerLoopStatus = z.infer<typeof workerLoopStatusSchema>;

export const metricsSnapshotSchema = z.object({
  generatedAt: z.string(),
  posts: z.number().int().nonnegative().default(0),
  targets: z.number().int().nonnegative().default(0),
  metrics: z.number().int().nonnegative().default(0),
  samples: z.number().int().nonnegative().default(0),
}).passthrough();
export type MetricsSnapshot = z.infer<typeof metricsSnapshotSchema>;

export const pipelineStatusSchema = z.object({
  ok: z.boolean(),
  generatedAt: z.string(),
  gitRevision: z.string().nullable(),
  pipelineDb: z.object({
    path: z.string(),
    exists: z.boolean(),
  }),
  jobs: z.array(publicationJobSchema).default([]),
  workers: z.array(workerLoopStatusSchema).default([]),
  metrics: metricsSnapshotSchema.optional(),
}).passthrough();
export type PipelineStatus = z.infer<typeof pipelineStatusSchema>;
