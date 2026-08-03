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

type DeliveryAdapterHooks = Pick<DeliveryAdapter, "validate" | "verify"> & Partial<Pick<DeliveryAdapter, "prepare">>;

/** Build one explicit adapter; validation and verification are never implicit no-ops. */
export function deliveryAdapter(publish: DeliveryPublisher, hooks: DeliveryAdapterHooks): DeliveryAdapter {
  const prepare = hooks.prepare ?? (async (job: ClaimedPublishJob) => job);
  return {
    publish,
    prepare,
    validate: hooks.validate,
    verify: hooks.verify,
  };
}

/** The workflow selects an adapter only by the durable publication target. */
export type DeliveryPorts = Record<string, DeliveryAdapter>;
