import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/foundation/config.js";

describe("loadConfig", () => {
  it("keeps production data paths compatible", () => {
    const config = loadConfig({});
    expect(config.PIPELINE_DB).toBe("/data/pipeline.db");
    expect(config.TELEGRAM_API_BASE_URL).toBe("http://bot-api:8081");
    expect(config.PIPELINE_BASELINE_MESSAGE_ID).toBe(422);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.STUDIO_MEDIA_MAX_BYTES).toBe(100_000_000);
    expect(config.VIDEO_MAX_BYTES).toBe(100_000_000);
  });

  it("uses controller token as primary bot token", () => {
    const config = loadConfig({ CONTROLLER_BOT_TOKEN: "controller", TELEGRAM_BOT_TOKEN: "telegram" });
    expect(config.controllerBotToken).toBe("controller");
  });

  it("accepts the production controller admin variable", () => {
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "101, 202" });
    expect(config.ADMIN_IDS).toEqual([101, 202]);
  });

  it("rejects enabled Stories with incomplete credentials at startup", () => {
    expect(() => loadConfig({ ENABLE_TELEGRAM_STORIES: "true" })).toThrow("TELEGRAM_STORIES_CHANNEL is required");
    expect(() => loadConfig({ ENABLE_INSTAGRAM_STORIES: "true" })).toThrow("INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_USER_ID are required");
  });

  it("requires a complete private deployment-agent configuration", () => {
    expect(() => loadConfig({ DEPLOY_AGENT_URL: "http://host.docker.internal:9899" })).toThrow("DEPLOY_AGENT_URL and DEPLOY_AGENT_TOKEN");
    expect(() => loadConfig({ DEPLOY_AGENT_TOKEN: "a".repeat(16) })).toThrow("DEPLOY_AGENT_URL and DEPLOY_AGENT_TOKEN");
    expect(loadConfig({ DEPLOY_AGENT_URL: "http://host.docker.internal:9899", DEPLOY_AGENT_TOKEN: "a".repeat(16) }).DEPLOY_AGENT_URL).toBe(
      "http://host.docker.internal:9899",
    );
  });

  it("requires Studio MCP token and owner to be configured together", () => {
    expect(() => loadConfig({ MCP_STUDIO_TOKEN: "a".repeat(16) })).toThrow("MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID");
    expect(() => loadConfig({ MCP_STUDIO_ACTOR_ID: "42" })).toThrow("MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID");
    expect(() => loadConfig({ MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" })).toThrow(
      "MCP_STUDIO_ACTOR_ID must belong to ADMIN_IDS",
    );
    expect(loadConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" }).MCP_STUDIO_ACTOR_ID).toBe(42);
  });
});
