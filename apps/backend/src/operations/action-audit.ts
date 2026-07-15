import type { BackendDb } from "../db/client.js";
import { opsActions } from "../db/schema.js";
import type { PublicationRef } from "./publication-ref.js";

export function recordOperationAction(
  backendDb: BackendDb,
  action: string,
  ref: PublicationRef,
  target: string | null,
  details: Record<string, unknown>,
  actorType = "command-center",
): void {
  const now = new Date().toISOString();
  backendDb.db
    .insert(opsActions)
    .values({
      actorType,
      action,
      messageId: ref.messageId,
      target,
      status: "ok",
      detailsJson: JSON.stringify(details),
      createdAt: now,
      completedAt: now,
    })
    .run();
}
