import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/foundation/config.js";
import { authorizationCode, authorizeThreads, threadsAuthorizeUrl } from "../src/operations/threads-authorize.js";

const configured = { THREADS_APP_ID: "990602627938098", THREADS_APP_SECRET: "app-secret", PUBLIC_BASE_URL: "https://studio.example.com" };

function threads(replies: { short?: unknown; long?: unknown }) {
  const requests: { url: string; body?: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(init?.body ? { url, body: String(init.body) } : { url });
    const payload = url.includes("/oauth/access_token") ? replies.short : replies.long;
    if (!payload) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

describe("threads authorization", () => {
  it("hands back a long-lived token, not the short-lived one it started from", async () => {
    // The code is single-use and lasts an hour, so stopping halfway would leave
    // the operator holding something that expires before they can use it.
    const { requests, fetchImpl } = threads({
      short: { access_token: "short-lived", user_id: 17841405793187218 },
      long: { access_token: "long-lived" },
    });

    const result = await authorizeThreads(
      loadConfig(configured),
      "ru",
      async () => "https://studio.example.com/oauth/threads?code=AQBx-hBsH3#_",
      { fetchImpl },
    );

    expect(result).toMatchObject({ variable: "THREADS_RU_ACCESS_TOKEN", accessToken: "long-lived", userId: "17841405793187218" });
    // The second call must carry the token the first one produced.
    expect(requests[1]?.url).toContain("access_token=short-lived");
    expect(requests[1]?.url).toContain("grant_type=th_exchange_token");
  });

  it("sends back the same redirect it sent the operator to", async () => {
    // Meta rejects the exchange when the two differ, and the failure says
    // nothing about which half was wrong.
    const config = loadConfig(configured);
    const { requests, fetchImpl } = threads({ short: { access_token: "short-lived" }, long: { access_token: "long-lived" } });
    await authorizeThreads(config, "en", async () => "code-pasted-bare", { fetchImpl });

    const sent = new URLSearchParams(requests[0]?.body ?? "");
    expect(sent.get("redirect_uri")).toBe("https://studio.example.com/oauth/threads");
    expect(threadsAuthorizeUrl(config, "990602627938098")).toContain(encodeURIComponent("https://studio.example.com/oauth/threads"));
    expect(sent.get("code")).toBe("code-pasted-bare");
  });

  it("asks for both halves of the Threads app before opening a browser", async () => {
    await expect(authorizeThreads(loadConfig({ PUBLIC_BASE_URL: "https://studio.example.com" }), "ru", async () => "code")).rejects.toThrow(
      "THREADS_APP_ID",
    );
  });

  describe("reading what the operator pasted", () => {
    it("takes the whole address and strips the tail Meta appends", () => {
      expect(authorizationCode("https://studio.example.com/oauth/threads?code=AQBx-hBsH3#_")).toBe("AQBx-hBsH3");
    });

    it("takes a bare code too", () => {
      expect(authorizationCode("  AQBx-hBsH3  ")).toBe("AQBx-hBsH3");
    });

    it("repeats a refusal rather than reporting a missing code", () => {
      // Declining redirects to the same URL with an explanation, and "no code
      // there" would send the operator hunting for a fault that is not theirs.
      expect(() =>
        authorizationCode("https://studio.example.com/oauth/threads?error=access_denied&error_description=The+user+denied+your+request"),
      ).toThrow("The user denied your request");
    });

    it("says what went wrong when the address carries no code at all", () => {
      expect(() => authorizationCode("https://studio.example.com/oauth/threads")).toThrow("no code parameter");
      expect(() => authorizationCode("   ")).toThrow("Nothing was pasted");
    });
  });
});
