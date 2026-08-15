import { describe, expect, it } from "bun:test";
import { deleteDiscordMessage, publishToDiscord, verifyDiscordMessage } from "../src/delivery/social/discord.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * Discord's create-message API is a single call, so what is worth pinning here
 * is everything around it: a post over 2000 characters becomes several messages
 * in order rather than a rejected job, the media rides on the last of them, and
 * the permalink is only claimed when the guild is known.
 */

const config = Object.assign(loadTestConfig({ DISCORD_CHANNEL_ID: "555", DISCORD_GUILD_ID: "777" }), { DISCORD_BOT_TOKEN: "bot-token" });

type Recorded = { url: string; method: string; authorization: string | null; body: unknown };

function transport(ids: string[] = ["m1", "m2", "m3"], crosspostStatus = 200) {
  const calls: Recorded[] = [];
  const queue = [...ids];
  const fetchImpl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = init?.body;
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      authorization: headers.get("Authorization"),
      body: typeof body === "string" ? JSON.parse(body) : body instanceof FormData ? Object.fromEntries(body.entries()) : null,
    });
    if (url.endsWith("/crosspost")) return new Response("{}", { status: crosspostStatus, headers: { "content-type": "application/json" } });
    const id = queue.shift() ?? "m";
    return new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const created = () => calls.filter((call) => call.url.endsWith("/messages"));
  const crossposts = () => calls.filter((call) => call.url.endsWith("/crosspost"));
  return { calls, created, crossposts, fetchImpl };
}

describe("Discord publisher", () => {
  it("publishes one message and returns its permalink", async () => {
    const { created, fetchImpl } = transport(["42"]);
    const result = await publishToDiscord({ text: "Hello channel" }, config, fetchImpl);

    expect(result).toMatchObject({ ok: true, id: "42", ids: ["42"], url: "https://discord.com/channels/777/555/42" });
    expect(created()).toHaveLength(1);
    expect(created()[0]?.url).toBe("https://discord.com/api/v10/channels/555/messages");
    expect(created()[0]?.method).toBe("POST");
    expect(created()[0]?.authorization).toBe("Bot bot-token");
    expect(created()[0]?.body).toEqual({ content: "Hello channel" });
  });

  it("publishes each message to the servers following the announcement channel", async () => {
    const { crossposts, fetchImpl } = transport(["a", "b"]);
    await publishToDiscord({ text: `${"word ".repeat(500)}\n\ntail` }, config, fetchImpl);

    expect(crossposts().map((call) => call.url)).toEqual([
      "https://discord.com/api/v10/channels/555/messages/a/crosspost",
      "https://discord.com/api/v10/channels/555/messages/b/crosspost",
    ]);
    expect(crossposts()[0]?.method).toBe("POST");
  });

  it("keeps the publication successful when the crosspost is refused", async () => {
    // The message is already in the channel. Failing the job here would retry
    // it and post the same text a second time.
    const { fetchImpl } = transport(["42"], 403);
    const result = await publishToDiscord({ text: "Hello" }, config, fetchImpl);

    expect(result).toMatchObject({ ok: true, id: "42" });
  });

  it("splits a post over the 2000-character cap into ordered messages", async () => {
    const { created, fetchImpl } = transport(["a", "b"]);
    const text = `${"word ".repeat(500)}\n\n${"tail ".repeat(50)}`.trim();
    const result = await publishToDiscord({ text }, config, fetchImpl);

    expect(created()).toHaveLength(2);
    for (const call of created()) expect(String((call.body as { content: string }).content).length).toBeLessThanOrEqual(2000);
    // The first id is the post's identity; the rest still have to be recorded,
    // or a later delete would leave half the post in the channel.
    expect(result).toMatchObject({ ok: true, id: "a", ids: ["a", "b"] });
  });

  it("leaves the permalink unset when the guild is not configured", async () => {
    const { fetchImpl } = transport(["42"]);
    const withoutGuild = Object.assign(loadTestConfig({ DISCORD_CHANNEL_ID: "555" }), { DISCORD_BOT_TOKEN: "bot-token" });
    const result = await publishToDiscord({ text: "Hello" }, withoutGuild, fetchImpl);

    expect(result).toMatchObject({ ok: true, id: "42", url: null });
  });

  it("refuses to publish without credentials instead of calling the API", async () => {
    const { calls, fetchImpl } = transport();
    await expect(publishToDiscord({ text: "Hello" }, loadTestConfig({}), fetchImpl)).rejects.toThrow(
      "Discord is not configured: DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID",
    );
    expect(calls).toHaveLength(0);
  });

  it("verifies a message by reading it back from its own channel", async () => {
    const { calls, fetchImpl } = transport(["42"]);
    const verified = await verifyDiscordMessage("42", config, fetchImpl);

    expect(verified).toEqual({ id: "42", url: "https://discord.com/channels/777/555/42" });
    expect(calls[0]).toMatchObject({ url: "https://discord.com/api/v10/channels/555/messages/42", method: "GET" });
  });

  it("fails verification when the API returns another message", async () => {
    const { fetchImpl } = transport(["99"]);
    await expect(verifyDiscordMessage("42", config, fetchImpl)).rejects.toThrow("Discord verification did not return the expected message");
  });

  it("deletes a published message", async () => {
    const { calls, fetchImpl } = transport(["42"]);
    await deleteDiscordMessage("42", config, fetchImpl);

    expect(calls[0]).toMatchObject({ url: "https://discord.com/api/v10/channels/555/messages/42", method: "DELETE" });
  });
});
