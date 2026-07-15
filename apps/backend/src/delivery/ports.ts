import type { PublishResult } from "../publishing/errors.js";
import type { ClaimedPublishJob } from "../publishing/queue.js";

/** Backward-compatible callable publisher shape used by focused tests and integrations. */
export type DeliveryPort = (job: ClaimedPublishJob) => Promise<PublishResult>;

/**
 * Platform boundary. Publishing owns retry policy and durable jobs; an adapter
 * owns validation, provider API calls and an optional post-publish verification.
 * It never receives Telegram, MCP or HTTP interface state.
 */
export type DeliveryAdapter = DeliveryPort & {
  validate: (job: ClaimedPublishJob) => Promise<void>;
  publish: DeliveryPort;
  verify: (job: ClaimedPublishJob, result: PublishResult) => Promise<PublishResult>;
};

/** Wrap a publisher in the uniform Delivery contract while remaining callable for legacy consumers. */
export function deliveryAdapter(publish: DeliveryPort, hooks: Partial<Pick<DeliveryAdapter, "validate" | "verify">> = {}): DeliveryAdapter {
  return Object.assign(publish, {
    publish,
    validate: hooks.validate ?? (async () => undefined),
    verify: hooks.verify ?? (async (_job, result) => result),
  });
}

/** The workflow selects an adapter only by the durable publication target. */
export type DeliveryPorts = Record<string, DeliveryAdapter>;
