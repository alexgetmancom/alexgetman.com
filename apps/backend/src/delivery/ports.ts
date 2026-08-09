import type { PublishResult } from "../publishing/errors.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";

/** Provider mutation owned by one delivery adapter. */
export type DeliveryPublisher = (job: ClaimedPublishJob) => Promise<PublishResult>;

/**
 * Platform boundary for social publication jobs. Publishing owns retry policy
 * and durable jobs; an adapter owns validation, preparation, provider API calls
 * and post-publish verification. It never receives Telegram, MCP or HTTP state.
 */
export type DeliveryAdapter = {
  validate: (job: ClaimedPublishJob) => Promise<void>;
  prepare: (job: ClaimedPublishJob) => Promise<ClaimedPublishJob>;
  publish: DeliveryPublisher;
  verify: (job: ClaimedPublishJob, result: PublishResult) => Promise<PublishResult>;
};

/** The workflow selects an adapter only by the durable publication target. */
export type DeliveryPorts = Record<string, DeliveryAdapter>;
