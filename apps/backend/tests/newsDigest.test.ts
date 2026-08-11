import { describe, expect, it } from "bun:test";
import type { Bot, InputFile } from "grammy";
import { loadConfig } from "../src/foundation/config.js";
import { type GrokSpawn, sendDailyNewsDigest } from "../src/interfaces/telegram/news-digest.js";
import { settingsService } from "../src/studio/services/settings.js";
import { withDb } from "./helpers/db.js";

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
              structuredOutput: { markdown: "" },
              text: `${JSON.stringify({ markdown: "Searching for today's news..." })}${JSON.stringify({ markdown: "1. **Today's news**\\n\\nOne item\\n\\n[Источник в X](https://x.com/example/status/1)" })}`,
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
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42,7" });
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
      expect(JSON.parse(commands[0]?.[7] ?? "{}")).toMatchObject({ properties: { markdown: { type: "string", pattern: "^1\\." } } });
      expect(commands[0]?.slice(8, 10)).toEqual(["--always-approve", "--single"]);
      expect(commands[0]?.[10]).toContain("Find today's AI news.");
      expect(commands[0]?.[10]).toContain("markdown value must begin immediately with item 1 as `1.`");
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
            JSON.stringify({ text: JSON.stringify({ markdown: "1. **News**\\n\\nOne item\\n\\n[Источник в X](https://x.com/news/1)" }) }),
          ),
          stderr: stream(""),
          exited: Promise.resolve(0),
          kill: () => {},
        };
      };
      const bot = { api: { sendDocument: async () => undefined } } as unknown as Bot;
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "disabled" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(runs).toBe(2);
    });
  });

  it("retries one malformed format and accepts a corrected response", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      let runs = 0;
      const commands: string[][] = [];
      const spawn: GrokSpawn = (command) => {
        runs += 1;
        commands.push(command);
        return {
          stdout: stream(
            JSON.stringify({
              text: JSON.stringify({
                markdown:
                  runs === 1
                    ? "News without the required prefix"
                    : "1. **Corrected news**\\n\\nOne item\\n\\n[Источник в X](https://x.com/news/1)",
              }),
            }),
          ),
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
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "sent" });
      expect(runs).toBe(2);
      expect(sent).toHaveLength(1);
      expect(commands[1]?.[10]).toContain("This is the final attempt");
    });
  });

  it("does not loop after the format retry fails", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: true, hour: 0, minute: 0, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return {
          stdout: stream(JSON.stringify({ text: JSON.stringify({ markdown: "News without the required prefix" }) })),
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
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });

      const result = await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T07:30:00.000Z"), { spawn });

      expect(result).toEqual({ status: "failed", error: "Grok news markdown must start with 1." });
      expect(runs).toBe(2);
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
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });

      expect(await sendDailyNewsDigest(config, backendDb, bot, new Date("2026-07-20T06:59:00.000Z"), { spawn })).toEqual({
        status: "not_due",
      });
    });
  });
});
