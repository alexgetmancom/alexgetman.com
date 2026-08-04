import { type BackendDb, unsafeDb } from "../db/client.js";
import { opsActions } from "../db/schema.js";
import type { ResolvedPublicationRef } from "./publication-ref.js";

export function recordOperationAction(
  backendDb: BackendDb,
  action: string,
  ref: ResolvedPublicationRef,
  target: string | null,
  details: Record<string, unknown>,
  actorType = "command-center",
): void {
  const now = new Date().toISOString();
  unsafeDb(backendDb)
    .db.insert(opsActions)
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
