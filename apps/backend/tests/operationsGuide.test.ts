import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOperationsGuide, formatOperationsGuide } from "../src/operations/guide.js";

describe("operations guide", () => {
  it("routes an unavailable local database to production", () => {
    const guide = buildOperationsGuide(join(mkdtempSync("alexgetman-guide-"), "missing.db"));

    expect(guide.local.state).toBe("missing");
    expect(guide.route).toBe("production");
    expect(guide.next.productionCommand).toBe("bun run ops:prod --account <alex|maru> <command>");
    expect(formatOperationsGuide(guide)).toContain("do not repair local /data");
  });

  it("keeps the local route when the database file is available", () => {
    const directory = mkdtempSync("alexgetman-guide-");
    writeFileSync(join(directory, "pipeline.db"), "placeholder");

    const guide = buildOperationsGuide(join(directory, "pipeline.db"));

    expect(guide.local.state).toBe("available");
    expect(guide.route).toBe("local");
    expect(guide.commands.find((command) => command.name === "publication-repair")).toMatchObject({
      mutates: true,
      usage: "publication-repair [--ref post:1|video:1] [--apply]",
    });
    expect(guide.commands.find((command) => command.name === "reschedule")).toMatchObject({ mutates: true });
  });
});
