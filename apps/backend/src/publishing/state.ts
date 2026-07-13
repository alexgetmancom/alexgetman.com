const VIDEO_FINAL_TARGET_STATUSES = new Set(["published", "failed", "cancelled"]);
const VIDEO_EDITABLE_TARGET_STATUSES = new Set(["editing", "draft"]);
const VIDEO_SCHEDULABLE_TARGET_STATUSES = new Set(["editing", "draft", "scheduled"]);
const ACTIVE_PUBLICATION_JOB_STATUSES = new Set(["queued", "publishing", "rendering"]);

export function isVideoTargetFinal(status: string): boolean {
  return VIDEO_FINAL_TARGET_STATUSES.has(status);
}

export function isVideoTargetEditable(status: string): boolean {
  return VIDEO_EDITABLE_TARGET_STATUSES.has(status);
}

export function isVideoTargetSchedulable(status: string): boolean {
  return VIDEO_SCHEDULABLE_TARGET_STATUSES.has(status);
}

export function videoDraftStatus(targetStatuses: string[]): "scheduled" | "published" | "partial" {
  if (!targetStatuses.every(isVideoTargetFinal)) return "scheduled";
  return targetStatuses.every((status) => status === "published") ? "published" : "partial";
}

export function publicationStatus(jobStatuses: string[]): "published" | "failed" | null {
  if (jobStatuses.some((status) => ACTIVE_PUBLICATION_JOB_STATUSES.has(status))) return null;
  return jobStatuses.some((status) => status === "failed") ? "failed" : "published";
}
