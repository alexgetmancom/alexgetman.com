import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOperationsGuide, formatOperationsGuide } from "../src/operations/guide.js";
import { operationCatalog } from "../src/operations/registry.js";

/** A bare prefix makes mkdtemp resolve against the working directory, so these
 * two tests used to leave a directory each in the repo root on every run. */
const directories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "alexgetman-guide-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("operations guide", () => {
  it("routes an unavailable local database to production", () => {
    const previousTarget = process.env.OPS_SSH_TARGET;
    process.env.OPS_SSH_TARGET = "";
    const guide = buildOperationsGuide(join(temporaryDirectory(), "missing.db"), operationCatalog());
    if (previousTarget === undefined) delete process.env.OPS_SSH_TARGET;
    else process.env.OPS_SSH_TARGET = previousTarget;

    expect(guide.local.state).toBe("missing");
    expect(guide.route).toBe("production");
    expect(guide.next.command).toBe("bun run ops:prod <command>");
    expect(guide.production.configured).toBe(false);
    expect(formatOperationsGuide(guide)).toContain("do not repair local /data");
    expect(formatOperationsGuide(guide)).toContain("Production launcher: not configured");
    // The container runs its last deployed revision, so this build's catalog is
    // a claim about the local tree, not about the route being recommended.
    expect(guide.catalog.authoritative).toBe(false);
    expect(guide.catalog.command).toBe("bun run ops:prod guide --json");
    expect(formatOperationsGuide(guide)).toContain("not the deployed one");
  });

  it("reports a configured production launcher without exposing its route", () => {
    const previousTarget = process.env.OPS_SSH_TARGET;
    process.env.OPS_SSH_TARGET = "deploy@example.test";
    const guide = buildOperationsGuide(join(temporaryDirectory(), "missing.db"), operationCatalog());
    if (previousTarget === undefined) delete process.env.OPS_SSH_TARGET;
    else process.env.OPS_SSH_TARGET = previousTarget;

    expect(guide.production.configured).toBe(true);
    expect(JSON.stringify(guide)).not.toContain("deploy@example.test");
    expect(formatOperationsGuide(guide)).not.toContain("deploy@example.test");
  });

  it("keeps the local route when the database file is available", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "pipeline.db"), "placeholder");

    const guide = buildOperationsGuide(join(directory, "pipeline.db"), operationCatalog());

    expect(guide.local.state).toBe("available");
    expect(guide.route).toBe("local");
    expect(guide.next.command).toBe("bun run --filter @solo-publisher/backend ops <command>");
    expect(guide.commands.find((command) => command.name === "publication-repair")).toMatchObject({
      mutates: true,
      usage: "publication-repair [--ref post:160] [--apply]",
    });
    expect(guide.commands.find((command) => command.name === "reschedule")).toMatchObject({ mutates: true });
    expect(guide.catalog.authoritative).toBe(true);
  });
});
