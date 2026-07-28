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
  prepare: (job: ClaimedPublishJob) => Promise<ClaimedPublishJob>;
  publish: DeliveryPort;
  verify: (job: ClaimedPublishJob, result: PublishResult) => Promise<PublishResult>;
};

/** Wrap a publisher in the uniform Delivery contract while remaining callable for legacy consumers. */
export function deliveryAdapter(
  publish: DeliveryPort,
  hooks: Partial<Pick<DeliveryAdapter, "validate" | "prepare" | "verify">> = {},
): DeliveryAdapter {
  const prepare = hooks.prepare ?? (async (job: ClaimedPublishJob) => job);
  const callable: DeliveryPort = async (job) => publish(await prepare(job));
  return Object.assign(callable, {
    publish,
    prepare,
    validate: hooks.validate ?? (async () => undefined),
    verify: hooks.verify ?? (async (_job, result) => result),
  });
}

/** The workflow selects an adapter only by the durable publication target. */
export type DeliveryPorts = Record<string, DeliveryAdapter>;
