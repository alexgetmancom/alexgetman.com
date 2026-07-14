import type { PublishResult } from "../publishing/errors.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";

/** A platform-specific Delivery adapter. It receives no interface state. */
export type DeliveryPort = (job: ClaimedPublishJob) => Promise<PublishResult>;

/** The workflow selects an adapter only by the durable publication target. */
export type DeliveryPorts = Record<string, DeliveryPort>;
