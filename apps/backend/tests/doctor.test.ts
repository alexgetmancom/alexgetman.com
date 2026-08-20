import { describe, expect, it } from "bun:test";
import { doctorChecks } from "../src/operations/doctor.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("doctor checks", () => {
  it("reports optional authoring interfaces without failing a site-only Studio", () => {
    const siteOnly = doctorChecks(loadTestConfig({ COMMAND_CENTER_TOKEN: "command-center" }), [
      { name: "DATA_DIR", path: "/data", writable: true },
    ]);
    expect(siteOnly.requiredChecks).toEqual({ dataDirectoriesWritable: true });
    expect(siteOnly.checks.telegramBot).toBe(false);

    const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }]);

    expect(result.checks.telegramBot).toBe(true);
    expect(result.checks.commandCenterTokenConfigured).toBe(true);
  });
});
