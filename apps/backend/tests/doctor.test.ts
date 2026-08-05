import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/foundation/config.js";
import { doctorChecks } from "../src/operations/doctor.js";

describe("doctor checks", () => {
  it("does not require a webhook secret when Telegram polling is enabled", () => {
    const config = loadConfig({ ENABLE_BOT_POLLING: "1", CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }]);

    expect(result.requiredChecks.webhookSecretConfigured).toBe(true);
    expect(result.requiredChecks.telegramBot).toBe(true);
    expect(result.checks.commandCenterTokenSeparated).toBe(true);
  });

  it("still requires the secret in webhook mode", () => {
    const config = loadConfig({ CONTROLLER_BOT_TOKEN: "bot", COMMAND_CENTER_TOKEN: "command-center" });
    const result = doctorChecks(config, [{ name: "DATA_DIR", path: "/data", writable: true }]);

    expect(result.requiredChecks.webhookSecretConfigured).toBe(false);
  });
});
