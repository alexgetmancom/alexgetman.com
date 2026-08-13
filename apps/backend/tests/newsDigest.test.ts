import { describe, expect, it } from "bun:test";
import type { Bot, InputFile } from "grammy";
import { loadConfig } from "../src/foundation/config.js";
import { type GrokSpawn, sendDailyNewsDigest } from "../src/interfaces/telegram/news-digest.js";
import { settingsService } from "../src/studio/services/settings.js";
import { withDb } from "./helpers/db.js";
import { MSK_STUDIO_CONFIG } from "./helpers/studio-config.js";

const textEncoder = new TextEncoder();

function stream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(textEncoder.encode(value));
      controller.close();
    },
  });
}

describe("daily news digest", () => {
  it("runs the saved prompt once after the daily time and sends a Markdown file to every administrator", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 10, minute: 0, prompt: "Find today's AI news." });
      const commands: string[][] = [];
      const spawn: GrokSpawn = (command) => {
        commands.push(command);
        return {
          stdout: stream(
            JSON.stringify({
              structuredOutput: {
                markdown: "1. **Today's news**\n\nOne item\n\n[Источник в X](https://x.com/example/status/1)",
              },
              text: '{"markdown": "1. **Today\'s news**"}',
              thought: "Internal reasoning must not be sent",
            }),
          ),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const sent: Array<{ actorId: number; document: InputFile }> = [];
      const bot = {
        api: {
          sendDocument: async (actorId: number, document: InputFile) => {
            sent.push({ actorId, document });
          },
        },
      } as unknown as Bot;
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42,7" });
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "sent" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "already_sent" });
      expect(commands[0]?.slice(0, 7)).toEqual([
        "grok",
        "--no-leader",
        "--reasoning-effort",
        "low",
        "--output-format",
        "json",
        "--json-schema",
      ]);
      const schema = JSON.parse(commands[0]?.[7] ?? "{}");
      expect(schema).toMatchObject({ properties: { markdown: { type: "string" } } });
      // A `pattern` here makes the constrained decoder satisfy the regex and stop: the digest comes back as "1.".
      expect(schema.properties.markdown.pattern).toBeUndefined();
      expect(commands[0]?.slice(8, 10)).toEqual(["--always-approve", "--single"]);
      expect(commands[0]?.[10]).toContain("Find today's AI news.");
      expect(commands[0]?.[10]).toContain("`markdown` field");
      expect(sent.map((item) => item.actorId)).toEqual([42, 7]);
      expect(sent.every((item) => item.document.filename === "news-digest-2026-07-20.md")).toBe(true);
      const first = sent.at(0);
      if (!first) throw new Error("The news digest was not sent");
      const raw = new TextDecoder().decode((await first.document.toRaw()) as Uint8Array);
      expect(raw.startsWith("1. **Today's news**")).toBe(true);
      expect(raw).toContain("[Источник в X](https://x.com/example/status/1)");
      expect(raw).not.toContain("I am searching");
      expect(raw).not.toContain("Internal reasoning must not be sent");
    });
  });

  it("waits for the configured time unless the operator presses send now", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: false, hour: 18, minute: 30, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return {
          stdout: stream(
            JSON.stringify({ structuredOutput: { markdown: "1. **News**\n\nOne item\n\n[Источник в X](https://x.com/news/1)" } }),
          ),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const bot = { api: { sendDocument: async () => undefined } } as unknown as Bot;
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42" });
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "disabled" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(runs).toBe(2);
    });
  });

  it("takes the digest from the last text object when search progress left structuredOutput null", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const spawn: GrokSpawn = () => ({
        // Grok streams progress updates as further schema-shaped objects; the digest is the last one.
        stdout: stream(
          JSON.stringify({
            structuredOutput: null,
            text: [
              JSON.stringify({ markdown: "Ищу в X, что реально обсуждают…" }),
              JSON.stringify({ markdown: "Добиваю первоисточники…" }),
              JSON.stringify({ markdown: "1. **Sonic × Fortnite**\n\nОдин пункт\n\nhttps://x.com/sonic/status/1" }),
            ].join(""),
            thought: "Internal reasoning must not be sent",
          }),
        ),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill: () => {},
      });
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42" });

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "sent" });
      const raw = new TextDecoder().decode((await sent[0]?.toRaw()) as Uint8Array);
      expect(raw.startsWith("1. **Sonic × Fortnite**")).toBe(true);
      expect(raw).not.toContain("Ищу в X");
      expect(raw).not.toContain("Добиваю первоисточники");
    });
  });

  it("fails when Grok never finished the digest", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return {
          // Only progress updates, no numbered list: shipping the chatter would be worse than failing.
          stdout: stream(JSON.stringify({ structuredOutput: null, text: JSON.stringify({ markdown: "Ищу в X, что обсуждают…" }) })),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42" });

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "failed", error: "Grok CLI did not return news markdown" });
      expect(runs).toBe(1);
      expect(sent).toHaveLength(0);
    });
  });

  it("rejects an empty digest instead of sending a blank file", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      const spawn: GrokSpawn = () => ({
        stdout: stream(JSON.stringify({ structuredOutput: { markdown: "  \n " } })),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill: () => {},
      });
      const sent: InputFile[] = [];
      const bot = {
        api: {
          sendDocument: async (_actorId: number, document: InputFile) => {
            sent.push(document);
          },
        },
      } as unknown as Bot;
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42" });

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "failed", error: "Grok returned an empty news digest" });
      expect(sent).toHaveLength(0);
    });
  });

  it("does not run before the selected time", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 10, minute: 0, prompt: "A prompt" });
      const spawn: GrokSpawn = () => {
        throw new Error("Grok should not start before the schedule");
      };
      const bot = { api: { sendDocument: async () => undefined } } as unknown as Bot;
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42" });

      expect(await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T06:59:00.000Z"), { spawn })).toEqual({
        status: "not_due",
      });
    });
  });
});
