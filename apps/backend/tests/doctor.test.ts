import { describe, expect, it } from "bun:test";
import { doctorChecks } from "../src/operations/doctor.js";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("doctor checks", () => {
  it("checks the single polling runtime", () => {
    const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }]);

    expect(result.requiredChecks.telegramBot).toBe(true);
    expect(result.checks.commandCenterTokenConfigured).toBe(true);
  });
});
