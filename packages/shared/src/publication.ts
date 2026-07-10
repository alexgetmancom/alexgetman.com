import { z } from "zod";
import { socialTargetSchema } from "./social.js";

export const publicationStatusSchema = z.enum([
  "draft",
  "queued",
  "scheduled",
  "publishing",
  "published",
  "skipped",
  "failed",
  "cancelled",
]);
export type PublicationStatus = z.infer<typeof publicationStatusSchema>;

export const publicationJobSchema = z.object({
  jobId: z.number().int().positive().optional(),
  postId: z.number().int().positive().nullable().optional(),
  postKey: z.string().nullable().optional(),
  messageId: z.number().int(),
  target: socialTargetSchema,
  status: publicationStatusSchema,
  attemptCount: z.number().int().nonnegative().default(0),
  publishAt: z.string().nullable().optional(),
  nextAttemptAt: z.string().nullable().optional(),
  lastError: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PublicationJob = z.infer<typeof publicationJobSchema>;
