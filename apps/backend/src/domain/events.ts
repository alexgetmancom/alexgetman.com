import type { DomainEventInput, EventStore } from "../application/ports.js";

export type { DomainEventInput } from "../application/ports.js";

/**
 * The durable event journal shared by Delivery, Studio inboxes and external
 * adapters. It deliberately contains no Telegram or transport-specific data.
 */
export function recordDomainEvent(events: EventStore, input: DomainEventInput): boolean {
  return events.record(input);
}
