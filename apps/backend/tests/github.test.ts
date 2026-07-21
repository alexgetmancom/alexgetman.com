import { describe, expect, it, mock } from "bun:test";
import { publishToGitHubDiscussion } from "../src/delivery/social/github.js";
import { loadConfig } from "../src/foundation/config.js";

const config = loadConfig({ GITHUB_DISCUSSIONS_TOKEN: "secret" });

describe("GitHub discussion publisher", () => {
  it("publishes and returns the discussion url", async () => {
    const fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ data: { createDiscussion: { discussion: { id: "D_1", url: "https://x/d/1" } } } }), { status: 200 }),
    );
    const result = await publishToGitHubDiscussion({ text_en: "Body" }, config, fetchMock as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, id: "D_1", url: "https://x/d/1" });
  });

  it("throws on a transient GraphQL error type so the job retries", async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }), { status: 200 }),
    );
    await expect(publishToGitHubDiscussion({ text_en: "Body" }, config, fetchMock as unknown as typeof fetch)).rejects.toThrow(
      /temporarily unavailable/,
    );
  });

  it("returns a terminal failure on a permanent GraphQL error type", async () => {
    const fetchMock = mock(
      async () => new Response(JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "no access" }] }), { status: 200 }),
    );
    const result = await publishToGitHubDiscussion({ text_en: "Body" }, config, fetchMock as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });
});
