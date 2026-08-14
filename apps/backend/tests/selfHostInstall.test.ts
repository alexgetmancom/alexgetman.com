import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/foundation/config.js";

const root = join(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The environment a fresh install actually starts with: every assignment in
 * .env.example, plus what compose.yaml sets around it. Keys the template ships
 * without a value stay empty here on purpose — that is what Docker passes. */
function installEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const line of read(".env.example").split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) env[match[1]] = match[2] ?? "";
  }
  const compose = read("compose.yaml");
  for (const [, key, value] of compose.matchAll(/^ {6}([A-Z][A-Z0-9_]*): "?([^"\n]*)"?$/gm)) {
    if (key !== undefined && value !== undefined && !value.includes("${")) env[key] = value;
  }
  return {
    ...env,
    PUBLIC_BASE_URL: "https://publisher.example.com",
    STUDIO_CONFIG: join(root, "studio.yaml"),
    ...overrides,
  };
}

describe("the published self-host install", () => {
  it("starts with nothing configured but the domain and the two secrets", () => {
    // The README promises a Studio with no credentials serves its site and its
    // Command Center. This failed for every fresh install: an .env file states
    // an unset key as `KEY=`, and those empty strings reached optional fields
    // as present-but-invalid values.
    const config = loadConfig(installEnvironment({ COMMAND_CENTER_TOKEN: "a".repeat(64), CLIENT_IP_HASH_SALT: "b".repeat(64) }));

    expect(config.NODE_ENV).toBe("production");
    expect(config.PUBLIC_BASE_URL).toBe("https://publisher.example.com");
    expect(config.COMMAND_CENTER_URL).toBe("https://publisher.example.com/command-center");
    expect(config.studio.siteEnabled).toBe(true);
    // Nothing is connected, and nothing pretends to be.
    expect(config.controllerBotToken).toBeUndefined();
    expect(config.MCP_STUDIO_TOKEN).toBeUndefined();
    expect(config.TELEGRAM_CHANNEL_USERNAME).toBe("");
  });

  it("still refuses to start without the secrets it cannot invent", () => {
    expect(() => loadConfig(installEnvironment())).toThrow("COMMAND_CENTER_TOKEN");
    expect(() => loadConfig(installEnvironment({ COMMAND_CENTER_TOKEN: "a".repeat(64) }))).toThrow("CLIENT_IP_HASH_SALT");
  });

  it("names no channel, so an unconfigured Studio cannot publish into someone else's", () => {
    // The default used to be a live channel. Anything that would have published
    // there now has nothing to publish to.
    expect(read("apps/backend/src/foundation/config.ts")).not.toContain('default("alexgetmancom")');
    expect(
      loadConfig(installEnvironment({ COMMAND_CENTER_TOKEN: "a".repeat(64), CLIENT_IP_HASH_SALT: "b".repeat(64) }))
        .TELEGRAM_CHANNEL_USERNAME,
    ).toBe("");
  });
});
