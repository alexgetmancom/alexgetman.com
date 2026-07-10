import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("keeps production data paths compatible", () => {
    const config = loadConfig({});
    expect(config.PIPELINE_DB).toBe("/data/pipeline.db");
    expect(config.TELEGRAM_API_BASE_URL).toBe("http://bot-api:8081");
    expect(config.PIPELINE_BASELINE_MESSAGE_ID).toBe(422);
  });

  it("uses controller token as primary bot token", () => {
    const config = loadConfig({ CONTROLLER_BOT_TOKEN: "controller", TELEGRAM_BOT_TOKEN: "telegram" });
    expect(config.controllerBotToken).toBe("controller");
  });

  it("accepts the production controller admin variable", () => {
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "101, 202" });
    expect(config.ADMIN_IDS).toEqual([101, 202]);
  });
});
