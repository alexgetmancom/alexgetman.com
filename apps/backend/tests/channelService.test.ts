import { describe, expect, it } from "bun:test";
import type { BackendDb } from "../src/db/client.js";
import { channelService } from "../src/studio/services/channels.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("Studio channel service", () => {
  it("discovers Zernio accounts through the injected fetch implementation", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ accounts: [{ _id: "account-1", username: "alex" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const service = channelService({} as BackendDb, Object.assign(loadTestConfig({}), { ZERNIO_API_KEY: "z".repeat(16) }), fetchImpl);

    await expect(service.discoverZernioAccounts()).resolves.toEqual([{ _id: "account-1", username: "alex" }]);
    expect(calls).toEqual([{ url: "https://zernio.com/api/v1/accounts", authorization: `Bearer ${"z".repeat(16)}` }]);
  });
});
