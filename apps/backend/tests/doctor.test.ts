import { describe, expect, it } from "bun:test";
import { doctorChecks } from "../src/operations/doctor.js";
import type { MediaBackupStatus } from "../src/operations/media-backup.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const backedUp: MediaBackupStatus = {
  directory: "/backups",
  onDataVolume: false,
  latest: { path: "/backups/media-20260820T000000Z.tar.gz", createdAt: "2026-08-20T00:00:00.000Z", bytes: 1 },
  ageDays: 1,
  ok: true,
};

describe("doctor checks", () => {
  it("reports optional authoring interfaces without failing a site-only Studio", () => {
    const siteOnly = doctorChecks(
      loadTestConfig({ COMMAND_CENTER_TOKEN: "command-center" }),
      [{ name: "DATA_DIR", path: "/data", writable: true }],
      backedUp,
    );
    expect(siteOnly.requiredChecks).toEqual({ dataDirectoriesWritable: true, mediaBackedUp: true });
    expect(siteOnly.checks.telegramBot).toBe(false);

    const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }], backedUp);

    expect(result.checks.telegramBot).toBe(true);
    expect(result.checks.commandCenterTokenConfigured).toBe(true);
  });

  it("fails a deployment whose media has no off-volume backup", () => {
    const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "command-center" });
    const directories = [{ name: "DATA_DIR", path: "/data", writable: true }];
    const missing = doctorChecks(config, directories, { ...backedUp, latest: null, ageDays: null, ok: false });
    expect(missing.requiredChecks.mediaBackedUp).toBe(false);

    // A copy on the volume it is meant to survive is not a backup.
    const onVolume = doctorChecks(config, directories, { ...backedUp, onDataVolume: true, ok: false });
    expect(onVolume.requiredChecks.mediaBackedUp).toBe(false);
  });
});
