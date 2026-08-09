import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/foundation/config.js";
import { doctorChecks } from "../src/operations/doctor.js";

describe("doctor checks", () => {
  it("checks the single polling runtime", () => {
    const config = loadConfig({ CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }]);

    expect(result.requiredChecks.telegramBot).toBe(true);
    expect(result.checks.commandCenterTokenConfigured).toBe(true);
  });
});
