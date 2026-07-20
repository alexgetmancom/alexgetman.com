import { describe, expect, it } from "bun:test";
import { posts } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { sendDailyEditorialInbox } from "../src/interfaces/telegram/editorial-inbox.js";
import { withDb } from "./helpers/db.js";

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
      const bot = { api: { sendMessage: async (_adminId: number, text: string) => void sent.push(text) } } as any;
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
      const config = loadConfig({ ADMIN_IDS: "42", DEEPSEEK_API_KEY: "key", EDITORIAL_INBOX_HOUR_MSK: "10" });
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyEditorialInbox(config, backendDb, bot, now, fetchImpl as unknown as typeof fetch)).toBe(true);
      expect(sent[0]).toContain("Цены Kimi");
      expect(await sendDailyEditorialInbox(config, backendDb, bot, now, fetchImpl as unknown as typeof fetch)).toBe(false);
    });
  });

  it("waits for the configured Moscow delivery hour", async () => {
    await withDb(async (backendDb) => {
      const bot = { api: { sendMessage: async () => undefined } } as any;
      const config = loadConfig({ ADMIN_IDS: "42", DEEPSEEK_API_KEY: "key", EDITORIAL_INBOX_HOUR_MSK: "10" });
      expect(await sendDailyEditorialInbox(config, backendDb, bot, new Date("2026-07-20T06:30:00.000Z"))).toBe(false);
    });
  });
});
