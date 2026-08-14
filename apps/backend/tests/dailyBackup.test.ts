import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Bot } from "grammy";
import { loadConfig } from "../src/foundation/config.js";
import { sendDailyBackup } from "../src/interfaces/telegram/backup.js";
import { settingsService } from "../src/studio/services/settings.js";
import { openBackendDb } from "./helpers/open-db.js";
import { MSK_STUDIO_CONFIG } from "./helpers/studio-config.js";

type Sent = { actorId: number; filename: string; silent: boolean; caption: string };

function recordingBot(sent: Sent[]): Bot {
  return {
    api: {
      sendDocument: async (actorId: number, file: { filename?: string }, options: { caption?: string; disable_notification?: boolean }) => {
        sent.push({
          actorId,
          filename: file.filename ?? "",
          silent: options.disable_notification === true,
          caption: options.caption ?? "",
        });
      },
    },
  } as unknown as Bot;
}

/** A real file on disk: the snapshot is taken with SQLite's own backup, which
 * needs somewhere to write and refuses an in-memory source. */
function withDatabase(run: (path: string, backendDb: ReturnType<typeof openBackendDb>) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "daily-backup-test-"));
  const path = join(directory, "pipeline.db");
  writeFileSync(path, "");
  const backendDb = openBackendDb(path);
  return run(path, backendDb).finally(() => {
    backendDb.close();
    rmSync(directory, { recursive: true, force: true });
  });
}

const morning = new Date("2026-08-14T05:00:00.000Z"); // 08:00 in Europe/Moscow
const night = new Date("2026-08-14T00:30:00.000Z"); // 03:30, before the hour

describe("daily database backup", () => {
  it("arrives once a day, silently, without anyone turning it on", async () => {
    await withDatabase(async (path, backendDb) => {
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42,7", PIPELINE_DB: path });
      const sent: Sent[] = [];

      expect(await sendDailyBackup(config, backendDb, recordingBot(sent), morning)).toBe("sent");
      expect(sent).toHaveLength(2);
      expect(sent.map((entry) => entry.actorId)).toEqual([42, 7]);
      // Every day forever: worth having, not worth a notification.
      expect(sent.every((entry) => entry.silent)).toBe(true);
      expect(sent[0]?.filename).toMatch(/^pipeline-\d{8}T\d{6}Z\.db$/);

      // A second tick the same day must not send it again.
      expect(await sendDailyBackup(config, backendDb, recordingBot(sent), morning)).toBe("not_due");
      expect(sent).toHaveLength(2);
    });
  });

  it("waits for the hour and obeys the setting", async () => {
    await withDatabase(async (path, backendDb) => {
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, CONTROLLER_ADMIN_IDS: "42", PIPELINE_DB: path });
      const sent: Sent[] = [];

      expect(await sendDailyBackup(config, backendDb, recordingBot(sent), night)).toBe("not_due");

      settingsService(backendDb).setBackup({ enabled: false });
      expect(await sendDailyBackup(config, backendDb, recordingBot(sent), morning)).toBe("disabled");
      expect(sent).toHaveLength(0);

      settingsService(backendDb).setBackup({ enabled: true });
      expect(await sendDailyBackup(config, backendDb, recordingBot(sent), morning)).toBe("sent");
      expect(sent).toHaveLength(1);
    });
  });

  it("has nowhere to send it without an administrator", async () => {
    await withDatabase(async (path, backendDb) => {
      const config = loadConfig({ STUDIO_CONFIG: MSK_STUDIO_CONFIG, PIPELINE_DB: path });
      expect(await sendDailyBackup(config, backendDb, recordingBot([]), morning)).toBe("no_admins");
    });
  });
});
