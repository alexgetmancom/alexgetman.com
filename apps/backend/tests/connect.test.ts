import { describe, expect, it } from "bun:test";
import { redeemDeviceAuthorizations, startConnect } from "../src/channels/connect.js";
import { verifyMetaOauthState } from "../src/channels/meta-oauth.js";
import { listChannels } from "../src/channels/registry.js";
import { deviceAuthorizations, platformTokens } from "../src/db/schema.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const KEY = "ef".repeat(32);
const now = new Date("2026-08-16T09:00:00.000Z");
const config = loadTestConfig({
  PUBLIC_BASE_URL: "https://publisher.example.com",
  TOKEN_ENCRYPTION_KEY: KEY,
  THREADS_APP_ID: "threads-id",
  THREADS_APP_SECRET: "threads-secret",
  X_CLIENT_ID: "x-id",
  X_CLIENT_SECRET: "x-secret",
  YOUTUBE_RU_CLIENT_ID: "google-id",
  YOUTUBE_RU_CLIENT_SECRET: "google-secret",
});

function transport(...replies: unknown[]) {
  const calls: string[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL) => {
    calls.push(String(input));
    return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("connecting an account", () => {
  it("hands every surface the same link, whichever platform it is", () =>
    withDb(async (backendDb) => {
      const threads = await startConnect(config, backendDb, "threads", "ru", fetch, now);
      expect(threads).toMatchObject({ platform: "threads", locale: "ru", kind: "redirect", expiresInMinutes: 10 });
      if (threads.kind !== "redirect") throw new Error("expected a link");
      const link = new URL(threads.url);
      expect(link.origin + link.pathname).toBe("https://publisher.example.com/oauth/threads/start");
      expect(verifyMetaOauthState(config, link.searchParams.get("state") ?? "", now)).toEqual({ platform: "threads", locale: "ru" });

      // X publishes as one account, so it has no language to name.
      const x = await startConnect(config, backendDb, "x", "ru", fetch, now);
      expect(x.locale).toBeNull();
      if (x.kind !== "redirect") throw new Error("expected a link");
      expect(new URL(x.url).origin).toBe("https://x.com");
    }));

  it("answers YouTube with a code to type, and keeps the half that redeems it", () =>
    withDb(async (backendDb) => {
      const { fetchImpl, calls } = transport({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_url: "https://www.google.com/device",
        interval: 5,
        expires_in: 1800,
      });

      const start = await startConnect(config, backendDb, "youtube", "ru", fetchImpl, now);

      expect(start).toEqual({
        platform: "youtube",
        locale: "ru",
        kind: "device",
        verificationUrl: "https://www.google.com/device",
        userCode: "ABCD-EFGH",
        expiresInSeconds: 1800,
      });
      expect(calls[0]).toBe("https://oauth2.googleapis.com/device/code");
      // Sealed: it is what redeems the grant until the operator approves.
      const pending = backendDb.db.select().from(deviceAuthorizations).get();
      expect(pending?.sealedDeviceCode).not.toContain("device-secret");
      expect(pending?.target).toBe("youtube_ru");
    }));

  it("finishes an approved authorization without anyone holding a terminal open", () =>
    withDb(async (backendDb) => {
      const started = transport({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_url: "https://www.google.com/device",
        expires_in: 1800,
      });
      await startConnect(config, backendDb, "youtube", "ru", started.fetchImpl, now);

      // Still waiting is the ordinary answer, and it changes nothing.
      const waiting = transport({ error: "authorization_pending" });
      expect(await redeemDeviceAuthorizations(config, backendDb, waiting.fetchImpl, now)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toHaveLength(1);

      const approved = transport({ refresh_token: "1//refresh" });
      expect(await redeemDeviceAuthorizations(config, backendDb, approved.fetchImpl, now)).toBe(1);

      const stored = backendDb.db.select().from(platformTokens).get();
      expect(stored?.target).toBe("youtube_ru");
      expect(stored?.sealedToken).not.toContain("1//refresh");
      expect(config.YOUTUBE_RU_REFRESH_TOKEN).toBe("1//refresh");
      expect(listChannels(backendDb).map((channel) => channel.id)).toContain("youtube_ru");
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toEqual([]);
    }));

  it("forgets an authorization nobody approved in time", () =>
    withDb(async (backendDb) => {
      const started = transport({ device_code: "d", user_code: "c", verification_url: "https://www.google.com/device", expires_in: 60 });
      await startConnect(config, backendDb, "youtube", "ru", started.fetchImpl, now);

      const later = new Date(now.getTime() + 120_000);
      const unused = transport({ error: "should not be asked" });
      expect(await redeemDeviceAuthorizations(config, backendDb, unused.fetchImpl, later)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toEqual([]);
      expect(unused.calls).toEqual([]);
    }));

  it("names what is missing instead of starting something that cannot finish", () =>
    withDb(async (backendDb) => {
      await expect(startConnect(loadTestConfig({}), backendDb, "youtube", "en", fetch, now)).rejects.toThrow(
        "YOUTUBE_EN_CLIENT_ID, YOUTUBE_EN_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY",
      );
      await expect(startConnect(loadTestConfig({}), backendDb, "instagram", "ru", fetch, now)).rejects.toThrow("INSTAGRAM_APP_ID");
    }));
});
