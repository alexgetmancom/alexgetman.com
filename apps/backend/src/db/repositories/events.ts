import { and, eq, gte, isNull } from "drizzle-orm";
import type { Clock, DomainEventInput, EventStore } from "../../application/ports.js";
import { postEvents } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** Durable SQLite implementation of the application event port. */
export function createEventStore(db: BackendDatabase, clock: Clock): EventStore {
  return {
    record: (input) => recordEvent(db, clock, input),
  };
}

/** Same event implementation against either the root database or a transaction handle. */
export function recordEvent(db: Pick<BackendDatabase, "select" | "insert">, clock: Clock, input: DomainEventInput): boolean {
  const now = clock.now().toISOString();
  const ref = input.ref ?? null;
  const target = input.target ?? null;
  if (input.cooldownSeconds) {
    const cutoff = new Date(clock.now().getTime() - input.cooldownSeconds * 1000).toISOString();
    const refCondition = ref == null ? isNull(postEvents.postKey) : eq(postEvents.postKey, ref);
    const targetCondition = target == null ? isNull(postEvents.target) : eq(postEvents.target, target);
    const duplicate = db
      .select({ id: postEvents.id })
      .from(postEvents)
      .where(and(refCondition, eq(postEvents.eventType, input.type), targetCondition, gte(postEvents.createdAt, cutoff)))
      .get();
    if (duplicate) return false;
  }
  db.insert(postEvents)
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
