import { describe, expect, it } from "bun:test";
import { authorizeYouTube } from "../src/operations/youtube-authorize.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const credentials = { YOUTUBE_RU_CLIENT_ID: "client", YOUTUBE_RU_CLIENT_SECRET: "secret" };

function responder(replies: Record<string, unknown[]>): typeof fetch {
  const queues = new Map(Object.entries(replies).map(([url, list]) => [url, [...list]]));
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const queue = [...queues.entries()].find(([key]) => url.includes(key))?.[1];
    const body = queue?.shift();
    if (!body) throw new Error(`no reply queued for ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("youtube authorize", () => {
  it("waits through the pending replies and returns the token to store", async () => {
    // Google answers "authorization_pending" until the operator finishes the
    // consent screen. Treating that as a failure would make the command unusable
    // for exactly as long as a person takes to open a browser.
    const prompts: { verificationUrl: string; userCode: string }[] = [];
    const result = await authorizeYouTube(loadTestConfig(credentials), "ru", {
      fetchImpl: responder({
        "device/code": [{ device_code: "d", user_code: "ABCD-EFGH", verification_url: "https://google.com/device", interval: 1 }],
        "oauth2.googleapis.com/token": [{ error: "authorization_pending" }, { error: "slow_down" }, { refresh_token: "1//refresh" }],
      }),
      onPrompt: (prompt) => prompts.push({ verificationUrl: prompt.verificationUrl, userCode: prompt.userCode }),
      sleep: async () => {},
    });

    expect(prompts).toEqual([{ verificationUrl: "https://google.com/device", userCode: "ABCD-EFGH" }]);
    expect(result.refreshToken).toBe("1//refresh");
    // The name of the setting to paste it into, so the answer is complete.
    expect(result.variable).toBe("YOUTUBE_RU_REFRESH_TOKEN");
  });

  it("stops on a real refusal instead of polling until the deadline", async () => {
    await expect(
      authorizeYouTube(loadTestConfig(credentials), "ru", {
        fetchImpl: responder({
          "device/code": [{ device_code: "d", user_code: "X", verification_url: "https://google.com/device", interval: 1 }],
          "oauth2.googleapis.com/token": [{ error: "access_denied" }],
        }),
        sleep: async () => {},
      }),
    ).rejects.toThrow("access_denied");
  });

  it("names the two settings to create before anything else", async () => {
    await expect(authorizeYouTube(loadTestConfig({}), "en", { sleep: async () => {} })).rejects.toThrow("YOUTUBE_EN_CLIENT_ID");
  });
});
