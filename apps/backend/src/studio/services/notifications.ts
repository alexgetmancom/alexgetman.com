import type { BackendDb } from "../../db/client.js";
import { type DomainEventInput, recordDomainEvent } from "../../domain/events.js";
import type { BackendConfig } from "../../foundation/config.js";
import { canAccessStudioOwner } from "../access.js";

/** Durable Studio inbox backed by the existing operations event journal. */
export function notificationService(backendDb: BackendDb, config?: BackendConfig) {
  return {
    record(input: DomainEventInput): boolean {
      return recordDomainEvent(backendDb.events, input);
    },
    inbox(actorId: number, limit = 50) {
      // Filter after fetching: technical journal events can otherwise fill the
      // page before any actual Studio notification is reached.
      const events = backendDb.studioNotifications.unread(Math.max(limit * 10, 100));
      return events
        .filter((event) => isInboxEvent(event.eventType) && isVisibleTo(backendDb, config, event.postKey, actorId))
        .slice(0, limit);
    },
    get(actorId: number, id: number) {
      const event = backendDb.studioNotifications.get(id);
      return event && isInboxEvent(event.eventType) && isVisibleTo(backendDb, config, event.postKey, actorId) ? event : null;
    },
    acknowledge(actorId: number, id: number): boolean {
      const event = backendDb.studioNotifications.get(id);
      if (!event || !isInboxEvent(event.eventType) || !isVisibleTo(backendDb, config, event.postKey, actorId)) return false;
      return backendDb.studioNotifications.acknowledge(id, backendDb.clock.now().toISOString());
    },
  };
}

/** The event journal also powers audit/observability. Only explicit Studio
 * notifications belong in a human's inbox; worker progress never does. */
function isInboxEvent(eventType: string): boolean {
  return (
    eventType.startsWith("studio.notification.") ||
    eventType === "delivery.post.completed" ||
    eventType === "delivery.video.completed" ||
    eventType === "analytics.video_metrics.frozen"
  );
}

/** Operational events without a Studio entity remain shared; entity events are
 * visible to every trusted operator in the installation. */
function isVisibleTo(backendDb: BackendDb, config: BackendConfig | undefined, ref: string | null, actorId: number): boolean {
  if (!ref) return true;
  if (ref.startsWith("draft:")) {
    const id = Number(ref.slice("draft:".length));
    const ownerId = Number.isSafeInteger(id) ? backendDb.studioNotifications.draftOwner(id) : undefined;
    return ownerId != null && (config ? canAccessStudioOwner(config, actorId, ownerId) : ownerId === actorId);
  }
  if (ref.startsWith("video:")) {
    const id = Number(ref.slice("video:".length));
    if (!Number.isSafeInteger(id)) return false;
    const ownerId = backendDb.studioNotifications.videoOwner(id);
    return ownerId != null && (config ? canAccessStudioOwner(config, actorId, ownerId) : ownerId === actorId);
  }
  // A malformed id is a broken reference, not a shared operational event:
  // only a ref with no recognised entity at all may stay visible to everyone.
  if (ref.startsWith("post:")) {
    const id = Number(ref.slice("post:".length));
    return Number.isSafeInteger(id) && ownsPost(backendDb, config, id, actorId);
  }
  const postId = backendDb.studioNotifications.postIdForKey(ref);
  if (postId == null || !Number.isSafeInteger(postId)) return true;
  return ownsPost(backendDb, config, postId, actorId);
}

function ownsPost(backendDb: BackendDb, config: BackendConfig | undefined, postId: number, actorId: number): boolean {
  const ownerId = backendDb.studioNotifications.postOwner(postId);
  return ownerId != null && (config ? canAccessStudioOwner(config, actorId, ownerId) : ownerId === actorId);
}
