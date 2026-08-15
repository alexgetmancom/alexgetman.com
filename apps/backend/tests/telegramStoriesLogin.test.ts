import { describe, expect, it } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import { loginTelegramStories } from "../src/operations/telegram-stories-login.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const configured = {
  TELEGRAM_CHANNEL_STORIES_API_ID: "12345",
  TELEGRAM_CHANNEL_STORIES_API_HASH: "hash",
  TELEGRAM_CHANNEL_STORIES_SESSION: "/data/telegram_channel_stories",
};

const prompts = {
  phone: async () => "+70000000000",
  code: async () => "11111",
  password: async () => "",
};

function fakeClient(onStart?: () => void) {
  const calls: string[] = [];
  const client = {
    start: async (params: { phone: () => Promise<string>; code: () => Promise<string> }) => {
      calls.push("start");
      onStart?.();
      await params.phone();
      await params.code();
      return { username: "studio_account", displayName: "Studio" };
    },
    destroy: async () => {
      calls.push("destroy");
    },
  } as unknown as TelegramClient;
  return { client, calls };
}

describe("telegram stories login", () => {
  it("signs in and reports the account the session now belongs to", async () => {
    // Stories are posted by a user rather than a bot, so the operator has to
    // see which account they just signed in as: the wrong one fails much later,
    // at the first Story.
    const { client, calls } = fakeClient();
    const result = await loginTelegramStories(
      loadTestConfig(configured),
      prompts,
      () => {},
      () => client,
    );

    expect(result).toEqual({ signedIn: true, user: "@studio_account", session: "/data/telegram_channel_stories" });
    expect(calls).toEqual(["start", "destroy"]);
  });

  it("closes the client even when signing in fails", async () => {
    // A half-open MTProto connection outlives the command and holds the session
    // directory, so the next attempt fails for a reason that has nothing to do
    // with the credentials.
    const { client, calls } = fakeClient(() => {
      throw new Error("PHONE_CODE_INVALID");
    });

    await expect(
      loginTelegramStories(
        loadTestConfig(configured),
        prompts,
        () => {},
        () => client,
      ),
    ).rejects.toThrow("PHONE_CODE_INVALID");
    expect(calls).toEqual(["start", "destroy"]);
  });

  it("names what has to exist before it can run at all", async () => {
    const { client } = fakeClient();
    await expect(
      loginTelegramStories(
        loadTestConfig({}),
        prompts,
        () => {},
        () => client,
      ),
    ).rejects.toThrow("TELEGRAM_CHANNEL_STORIES_API_ID");
    await expect(
      loginTelegramStories(
        loadTestConfig({ TELEGRAM_CHANNEL_STORIES_API_ID: "1", TELEGRAM_CHANNEL_STORIES_API_HASH: "h" }),
        prompts,
        () => {},
        () => client,
      ),
    ).rejects.toThrow("TELEGRAM_CHANNEL_STORIES_SESSION");
  });
});
