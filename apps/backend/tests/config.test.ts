import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/foundation/config.js";

describe("loadConfig", () => {
  it("keeps production data paths compatible", () => {
    const config = loadConfig({});
    expect(config.PIPELINE_DB).toBe("/data/pipeline.db");
    expect(config.TELEGRAM_API_BASE_URL).toBe("http://bot-api:8081");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.STUDIO_MEDIA_MAX_BYTES).toBe(1_000_000_000);
    expect(config.VIDEO_MAX_BYTES).toBe(1_000_000_000);
    expect(config.STUDIO_MEDIA_DIR).toBe("/data/video-media");
  });

  it("requires an explicit matching production environment", () => {
    expect(() => loadConfig({ NODE_ENV: "production", COMMAND_CENTER_TOKEN: "b".repeat(16) })).toThrow("DEPLOYMENT_ENV=production");
    expect(() => loadConfig({ DEPLOYMENT_ENV: "production", COMMAND_CENTER_TOKEN: "b".repeat(16) })).toThrow("NODE_ENV=production");
    expect(
      loadConfig({
        NODE_ENV: "production",
        DEPLOYMENT_ENV: "production",
        COMMAND_CENTER_TOKEN: "b".repeat(16),
        CLIENT_IP_HASH_SALT: "s".repeat(16),
        TELEGRAM_CHANNEL_USERNAME: "example",
      }).NODE_ENV,
    ).toBe("production");
  });

  it("uses controller token as primary bot token", () => {
    const config = loadConfig({ CONTROLLER_BOT_TOKEN: "controller" });
    expect(config.controllerBotToken).toBe("controller");
  });

  it("accepts the production controller admin variable", () => {
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "101, 202" });
    expect(config.CONTROLLER_ADMIN_IDS).toEqual([101, 202]);
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
      "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS",
    );
    expect(
      loadConfig({ CONTROLLER_ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" }).MCP_STUDIO_ACTOR_ID,
    ).toBe(42);
  });

  it("rejects the removed ADMIN_IDS name when an MCP owner needs the roster", () => {
    expect(() => loadConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" })).toThrow(
      "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS",
    );
  });

  it("accepts a Studio actor that is not a Telegram admin", () => {
    // The point of the roster: an MCP-only deployment has an owner without
    // granting anyone bot access.
    const config = loadConfig({ STUDIO_ACTOR_IDS: "7", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "7" });
    expect(config.MCP_STUDIO_ACTOR_ID).toBe(7);
    expect(config.CONTROLLER_ADMIN_IDS).toEqual([]);
    expect(() => loadConfig({ STUDIO_ACTOR_IDS: "7", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "8" })).toThrow(
      "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS",
    );
  });
});
