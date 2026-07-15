import { describe, expect, it } from "bun:test";
import { deliveryAdapter } from "../src/delivery/ports.js";

describe("Delivery adapter contract", () => {
  it("runs validation, publish and verification through one transport-neutral adapter", async () => {
    const calls: string[] = [];
    const adapter = deliveryAdapter(
      async () => {
        calls.push("publish");
        return { ok: true, id: "provider-id" };
      },
      {
        validate: async () => {
          calls.push("validate");
        },
        verify: async (_job, result) => {
          calls.push("verify");
          return { ...result, url: "https://provider.example/post" };
        },
      },
    );
    const job = { jobId: 1, postKey: "post:1", target: "test", payload: {} } as never;
    await adapter.validate(job);
    const result = await adapter.verify(job, await adapter.publish(job));

    expect(calls).toEqual(["validate", "publish", "verify"]);
    expect(result).toMatchObject({ ok: true, url: "https://provider.example/post" });
    expect(await adapter(job)).toMatchObject({ ok: true });
  });
});
