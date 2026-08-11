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
        return { stdout: stream("# Today's news\n\n- One item"), stderr: stream(""), exited: Promise.resolve(0), kill: () => {} };
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
      expect(commands).toEqual([
        ["grok", "--no-leader", "--output-format", "plain", "--always-approve", "--single", "Find today's AI news."],
      ]);
      expect(sent.map((item) => item.actorId)).toEqual([42, 7]);
      expect(sent.every((item) => item.document.filename === "news-digest-2026-07-20.md")).toBe(true);
      const first = sent.at(0);
      if (!first) throw new Error("The news digest was not sent");
      expect(new TextDecoder().decode((await first.document.toRaw()) as Uint8Array)).toContain("# Today's news");
    });
  });

  it("waits for the configured time unless the operator presses send now", async () => {
    await withDb(async (backendDb) => {
      settingsService(backendDb).setNewsDigest({ enabled: false, hour: 18, minute: 30, prompt: "A prompt" });
      let runs = 0;
      const spawn: GrokSpawn = () => {
        runs += 1;
        return { stdout: stream("# News"), stderr: stream(""), exited: Promise.resolve(0), kill: () => {} };
      };
      const bot = { api: { sendDocument: async () => undefined } } as unknown as Bot;
      const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });
      const now = new Date("2026-07-20T07:30:00.000Z");

      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { spawn })).toEqual({ status: "disabled" });
      expect(await sendDailyNewsDigest(config, backendDb, bot, now, { force: true, spawn })).toEqual({ status: "sent" });
      expect(runs).toBe(1);
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
