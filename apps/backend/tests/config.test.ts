import { describe, expect, it } from "bun:test";
import { loadTestConfig } from "./helpers/studio-config.js";

describe("loadConfig", () => {
  it("keeps production data paths compatible", () => {
    const config = loadTestConfig({});
    expect(config.PIPELINE_DB).toBe("/data/pipeline.db");
    expect(config.TELEGRAM_API_BASE_URL).toBe("https://api.telegram.org");
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.STUDIO_MEDIA_MAX_BYTES).toBe(1_000_000_000);
    expect(config.STUDIO_MEDIA_DIR).toBe("/data/video-media");
    expect(config.REMOTE_MEDIA_PATH).toBe("/data/media");
    expect(config.PUBLIC_MEDIA_BASE_URL).toBe("https://alexgetman.com/media/staging");
  });

  it("requires an explicit matching production environment", () => {
    expect(() => loadTestConfig({ NODE_ENV: "production", COMMAND_CENTER_TOKEN: "b".repeat(16) })).toThrow("DEPLOYMENT_ENV=production");
    expect(() => loadTestConfig({ DEPLOYMENT_ENV: "production", COMMAND_CENTER_TOKEN: "b".repeat(16) })).toThrow("NODE_ENV=production");
    expect(
      loadTestConfig({
        NODE_ENV: "production",
        DEPLOYMENT_ENV: "production",
        COMMAND_CENTER_TOKEN: "b".repeat(16),
        CLIENT_IP_HASH_SALT: "s".repeat(16),
        TELEGRAM_CHANNEL_USERNAME: "example",
        PUBLIC_BASE_URL: "https://studio.example.com",
      }).NODE_ENV,
    ).toBe("production");
  });

  it("refuses to publish another Studio's domain", () => {
    // The default is a live site. Without this, a self-hosted Studio's feeds,
    // sitemap and canonical URLs all point at alexgetman.com.
    const production = {
      NODE_ENV: "production",
      DEPLOYMENT_ENV: "production",
      COMMAND_CENTER_TOKEN: "b".repeat(16),
      CLIENT_IP_HASH_SALT: "s".repeat(16),
      TELEGRAM_CHANNEL_USERNAME: "example",
    };
    expect(() => loadTestConfig(production)).toThrow("PUBLIC_BASE_URL");

    // One address, one setting: the dashboard URL and the media base follow the
    // site rather than being configured a second time.
    const config = loadTestConfig({ ...production, PUBLIC_BASE_URL: "https://studio.example.com/" });
    expect(config.COMMAND_CENTER_URL).toBe("https://studio.example.com/command-center");
    expect(config.PUBLIC_MEDIA_BASE_URL).toBe("https://studio.example.com/media/staging");
    expect(
      loadTestConfig({ ...production, PUBLIC_BASE_URL: "https://s.example.com", PUBLIC_MEDIA_BASE_URL: "https://cdn.example.com/m" })
        .PUBLIC_MEDIA_BASE_URL,
    ).toBe("https://cdn.example.com/m");
  });

  it("derives temporary media storage beside a custom site volume", () => {
    const config = loadTestConfig({ SITE_PUBLIC_DIR: "/srv/studio/site", PUBLIC_BASE_URL: "https://studio.example.com" });
    expect(config.REMOTE_MEDIA_PATH).toBe("/srv/studio/media");
    expect(config.PUBLIC_MEDIA_BASE_URL).toBe("https://studio.example.com/media/staging");
  });

  it("uses controller token as primary bot token", () => {
    const config = loadTestConfig({ CONTROLLER_BOT_TOKEN: "controller" });
    expect(config.controllerBotToken).toBe("controller");
  });

  it("accepts the production controller admin variable", () => {
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "101, 202" });
    expect(config.CONTROLLER_ADMIN_IDS).toEqual([101, 202]);
  });

  it("requires a complete private deployment-agent configuration", () => {
    expect(() => loadTestConfig({ DEPLOY_AGENT_URL: "http://host.docker.internal:9899" })).toThrow(
      "DEPLOY_AGENT_URL and DEPLOY_AGENT_TOKEN",
    );
    expect(() => loadTestConfig({ DEPLOY_AGENT_TOKEN: "a".repeat(16) })).toThrow("DEPLOY_AGENT_URL and DEPLOY_AGENT_TOKEN");
    expect(
      loadTestConfig({ DEPLOY_AGENT_URL: "http://host.docker.internal:9899", DEPLOY_AGENT_TOKEN: "a".repeat(16) }).DEPLOY_AGENT_URL,
    ).toBe("http://host.docker.internal:9899");
  });

  it("requires Studio MCP token and owner to be configured together", () => {
    expect(() => loadTestConfig({ MCP_STUDIO_TOKEN: "a".repeat(16) })).toThrow("MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID");
    expect(() => loadTestConfig({ MCP_STUDIO_ACTOR_ID: "42" })).toThrow("MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID");
    expect(() => loadTestConfig({ MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" })).toThrow(
      "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS",
    );
    expect(
      loadTestConfig({ CONTROLLER_ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" }).MCP_STUDIO_ACTOR_ID,
    ).toBe(42);
  });

  it("rejects the removed ADMIN_IDS name when an MCP owner needs the roster", () => {
    expect(() => loadTestConfig({ ADMIN_IDS: "42", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "42" })).toThrow(
      "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS",
    );
  });

  it("accepts a Studio actor that is not a Telegram admin", () => {
    // The point of the roster: an MCP-only deployment has an owner without
    // granting anyone bot access.
    const config = loadTestConfig({ STUDIO_ACTOR_IDS: "7", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "7" });
    expect(config.MCP_STUDIO_ACTOR_ID).toBe(7);
    expect(config.CONTROLLER_ADMIN_IDS).toEqual([]);
    expect(() => loadTestConfig({ STUDIO_ACTOR_IDS: "7", MCP_STUDIO_TOKEN: "a".repeat(16), MCP_STUDIO_ACTOR_ID: "8" })).toThrow(
      "MCP_STUDIO_ACTOR_ID must belong to STUDIO_ACTOR_IDS",
    );
  });
});
