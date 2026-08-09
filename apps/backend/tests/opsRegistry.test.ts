import { afterEach, describe, expect, it } from "bun:test";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { mcpResponse } from "../src/interfaces/mcp.js";
import { type OperationContext, operationCatalog, operationDef, operationUsage, runOperation } from "../src/operations/registry.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: UnsafeBackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

/** Moving the database file, writing credentials, or reading a path off the
 * host are the operations an MCP caller must never reach. This is the list, and
 * it is the one thing about the registry worth failing a build over. */
const HOST_ONLY = [
  "backup",
  "restore",
  "import-x-analytics",
  "import-manual-analytics",
  "capability-record",
  "site-media-images",
  "site-media-deduplicate",
  "channel-connect",
  "channel-disable",
];

function context(db: UnsafeBackendDb): OperationContext {
  return {
    dbPath: ":memory:",
    config: () => loadConfig({ CONTROLLER_ADMIN_IDS: "42" }),
    db: () => db,
    fetchImpl: fetch,
    actorType: "test",
  };
}

describe("operations registry", () => {
  it("keeps host-only operations off the agent surface", () => {
    const catalog = new Map(operationCatalog().map((entry) => [entry.name, entry]));

    for (const name of HOST_ONLY) expect(catalog.get(name)?.agent).toBe(false);
    expect(catalog.get("recent")?.agent).toBe(true);
    expect(catalog.get("retry")?.agent).toBe(true);
  });

  /** A usage line reading `--ref VALUE` is what produced `--ref 160` and the
   * round-trip it cost; the placeholder has to survive into the rendered line. */
  it("derives the usage line from the schema, showing the real invocation", () => {
    expect(operationUsage("retry", operationDef("retry") as never)).toBe("retry --ref post:160 [--target x] [--locale ru|en] [--apply]");
    expect(operationUsage("recent", operationDef("recent") as never)).toBe("recent [--limit VALUE]");
    expect(operationUsage("story-card-backfill", operationDef("story-card-backfill") as never)).toBe(
      "story-card-backfill --ref post:160 [--apply] [--force]",
    );
  });

  it("accepts the bare post number every other surface shows", async () => {
    backendDb = openBackendDb(":memory:");

    const normalized = (await runOperation("timeline", context(backendDb), { ref: "160" })) as { ref: string };

    expect(normalized.ref).toBe("post:160");
    await expect(runOperation("timeline", context(backendDb), { ref: "nonsense" })).rejects.toThrow("--ref must look like post:106");
  });

  it("validates input before the handler runs", async () => {
    backendDb = openBackendDb(":memory:");

    await expect(runOperation("recent", context(backendDb), { limit: 999 })).rejects.toThrow("recent: limit");
    await expect(runOperation("verify", context(backendDb), {})).rejects.toThrow("verify: ref");
    await expect(runOperation("nonsense", context(backendDb), {})).rejects.toThrow("unknown command: nonsense");
  });

  it("serves every agent operation as an MCP tool and nothing else", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });

    const listed = (await mcpResponse(backendDb, config, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "key", 42)) as {
      result: { tools: Array<{ name: string }> };
    };
    const opsTools = listed.result.tools.filter((tool) => tool.name.startsWith("ops_")).map((tool) => tool.name);

    expect(opsTools).toEqual(
      operationCatalog()
        .filter((entry) => entry.agent)
        .map((entry) => `ops_${entry.name.replace(/-/g, "_")}`),
    );
    for (const name of HOST_ONLY) expect(opsTools).not.toContain(`ops_${name.replace(/-/g, "_")}`);
  });

  it("refuses a host-only operation asked for over MCP", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });

    const response = (await mcpResponse(
      backendDb,
      config,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ops_restore", arguments: { source: "/tmp/backup.db" } } },
      "key",
      42,
    )) as { error: { code: number } };

    expect(response.error.code).toBe(-32601);
  });

  it("names the offending field when an agent calls an operation wrongly", async () => {
    backendDb = openBackendDb(":memory:");
    const config = loadConfig({ CONTROLLER_ADMIN_IDS: "42" });

    const response = (await mcpResponse(
      backendDb,
      config,
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ops_recent", arguments: { limit: 999 } } },
      "key",
      42,
    )) as { error: { code: number; message: string } };

    expect(response.error.code).toBe(-32602);
    expect(response.error.message).toContain("limit");
  });
});
