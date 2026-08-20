import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let fixtureDir: string | null = null;

afterEach(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = null;
});

async function runDoctor(overrides: Record<string, string> = {}) {
  fixtureDir = mkdtempSync(path.join(tmpdir(), "solo-publisher-doctor-"));
  for (const name of ["data", "media", "cache", "cards", "site"]) mkdirSync(path.join(fixtureDir, name));
  const child = Bun.spawn(["bun", "apps/backend/src/cli.ts", "doctor", "--db", path.join(fixtureDir, "pipeline.db")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "development",
      DEPLOYMENT_ENV: "development",
      COMMAND_CENTER_TOKEN: "command-center",
      DATA_DIR: path.join(fixtureDir, "data"),
      STUDIO_MEDIA_DIR: path.join(fixtureDir, "media"),
      VIDEO_MEDIA_DIR: path.join(fixtureDir, "media"),
      MEDIA_CACHE_DIR: path.join(fixtureDir, "cache"),
      STORY_CARD_DIR: path.join(fixtureDir, "cards"),
      SITE_PUBLIC_DIR: path.join(fixtureDir, "site"),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
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

  it("exits nonzero when its report is not ok", async () => {
    const result = await runDoctor({ CONTROLLER_BOT_TOKEN: "half-configured" });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('"ok": false');
    expect(result.stdout).toContain("CONTROLLER_ADMIN_IDS");
  });
});
