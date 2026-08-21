import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let fixtureDir: string | null = null;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = null;
});

async function runDoctor(overrides: (fixture: string) => Record<string, string> = () => ({})) {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "solo-publisher-doctor-"));
  const dataDir = path.join(fixtureDir, "data");
  // The backup directory sits beside the data volume, never inside it — the
  // deployment shape doctor is asserting about.
  const backupDir = path.join(fixtureDir, "backups");
  mkdirSync(dataDir);
  mkdirSync(backupDir);
  writeFileSync(path.join(backupDir, "media-20260820T000000Z.tar.gz"), "archive");
  const child = Bun.spawn(
    ["bun", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "doctor", "--db", path.join(fixtureDir, "pipeline.db")],
    {
      env: {
        ...process.env,
        NODE_ENV: "development",
        DEPLOYMENT_ENV: "development",
        COMMAND_CENTER_TOKEN: "command-center",
        DATA_DIR: dataDir,
        BACKUP_DIR: backupDir,
        ...overrides(fixtureDir),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("doctor CLI", () => {
  it("succeeds for a healthy Studio with no optional authoring interface", async () => {
    const result = await runDoctor();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain('"ok": true');
  });

  it("fails a deployment whose media backup lives on the data volume", async () => {
    // A copy inside DATA_DIR is lost with the volume it is meant to survive.
    const result = await runDoctor((fixture) => ({ BACKUP_DIR: path.join(fixture, "data", "backups") }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"mediaBackedUp": false');
    expect(result.stdout).toContain('"onDataVolume": true');
  });

  it("exits nonzero when its report is not ok", async () => {
    const result = await runDoctor(() => ({ CONTROLLER_BOT_TOKEN: "half-configured" }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"ok": false');
    expect(result.stdout).toContain("CONTROLLER_ADMIN_IDS");
  });
});
