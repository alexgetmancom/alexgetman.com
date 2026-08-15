import { describe, expect, it } from "bun:test";
import { posts } from "../src/db/schema.js";
import { type EditorialInboxBot, sendDailyEditorialInbox } from "../src/interfaces/telegram/editorial-inbox.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig, MSK_STUDIO_PROFILE } from "./helpers/studio-config.js";

describe("daily editorial inbox", () => {
  it("sends one AI-generated opportunity inbox per Moscow day", async () => {
    await withDb(async (backendDb) => {
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:7",
          postId: 7,
          source: "studio",
          channel: "studio",
          messageId: 7,
          status: "active",
          text: "Kimi changed API prices",
          createdAt: "2026-07-20T00:00:00.000Z",
          updatedAt: "2026-07-20T00:00:00.000Z",
        })
        .run();
      const sent: string[] = [];
      const bot: EditorialInboxBot = { api: { sendMessage: async (_actorId, text) => void sent.push(text) } };
      const fetchImpl = async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    items: [{ kind: "data", title: "Цены Kimi", reason: "В базе есть обновление цены Kimi", posts: [7] }],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      const config = loadTestConfig(
        {
          CONTROLLER_ADMIN_IDS: "42",
          DEEPSEEK_API_KEY: "key",
          EDITORIAL_INBOX_HOUR_MSK: "10",
        },
        MSK_STUDIO_PROFILE,
      );
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyEditorialInbox(config, backendDb, bot, now, fetchImpl as unknown as typeof fetch)).toBe(true);
      expect(sent[0]).toContain("Цены Kimi");
      expect(await sendDailyEditorialInbox(config, backendDb, bot, now, fetchImpl as unknown as typeof fetch)).toBe(false);
    });
  });

  it("sends only chat-completion fields to the provider, with the abort signal on the request", async () => {
    await withDb(async (backendDb) => {
      backendDb.db
        .insert(posts)
        .values({
          postKey: "post:8",
          postId: 8,
          source: "studio",
          channel: "studio",
          messageId: 8,
          status: "active",
          text: "Something published",
          createdAt: "2026-07-20T00:00:00.000Z",
          updatedAt: "2026-07-20T00:00:00.000Z",
        })
        .run();
      let init: RequestInit | undefined;
      const fetchImpl = (async (_url: string, requestInit: RequestInit) => {
        init = requestInit;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }), { status: 200 });
      }) as unknown as typeof fetch;
      const bot: EditorialInboxBot = { api: { sendMessage: async () => undefined } };
      const config = loadTestConfig(
        {
          CONTROLLER_ADMIN_IDS: "42",
          DEEPSEEK_API_KEY: "key",
          EDITORIAL_INBOX_HOUR_MSK: "10",
        },
        MSK_STUDIO_PROFILE,
      );

      await sendDailyEditorialInbox(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), fetchImpl);

      expect(JSON.parse(String(init?.body))).not.toHaveProperty("signal");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  it("waits for the configured Moscow delivery hour", async () => {
    await withDb(async (backendDb) => {
      const bot: EditorialInboxBot = { api: { sendMessage: async () => undefined } };
      const config = loadTestConfig(
        {
          CONTROLLER_ADMIN_IDS: "42",
          DEEPSEEK_API_KEY: "key",
          EDITORIAL_INBOX_HOUR_MSK: "10",
        },
        MSK_STUDIO_PROFILE,
      );
      expect(await sendDailyEditorialInbox(config, backendDb, bot, new Date("2026-07-20T06:30:00.000Z"))).toBe(false);
    });
  });
});
