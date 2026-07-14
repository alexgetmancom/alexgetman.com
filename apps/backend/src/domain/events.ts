import { and, eq, gte, isNull } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { postEvents } from "../db/schema.js";

export type DomainEventInput = {
  ref?: string | null;
  type: string;
  severity: "info" | "warn" | "error";
  target?: string | null;
  message: string;
  details?: Record<string, unknown>;
  cooldownSeconds?: number;
};

/**
 * The durable event journal shared by Delivery, Studio inboxes and external
 * adapters. It deliberately contains no Telegram or transport-specific data.
 */
export function recordDomainEvent(backendDb: BackendDb, input: DomainEventInput): boolean {
  const now = new Date().toISOString();
  const ref = input.ref ?? null;
  const target = input.target ?? null;
  if (input.cooldownSeconds) {
    const cutoff = new Date(Date.now() - input.cooldownSeconds * 1000).toISOString();
    const refCondition = ref == null ? isNull(postEvents.postKey) : eq(postEvents.postKey, ref);
    const targetCondition = target == null ? isNull(postEvents.target) : eq(postEvents.target, target);
    const duplicate = backendDb.db
      .select({ id: postEvents.id })
      .from(postEvents)
      .where(and(refCondition, eq(postEvents.eventType, input.type), targetCondition, gte(postEvents.createdAt, cutoff)))
      .get();
    if (duplicate) return false;
  }
  backendDb.db
    .insert(postEvents)
    .values({
      postKey: ref,
      eventType: input.type,
      severity: input.severity,
      target,
      message: input.message,
      detailsJson: JSON.stringify(input.details ?? {}),
      createdAt: now,
    })
    .run();
  return true;
}
