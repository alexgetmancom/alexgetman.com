import { type BackendDb, baselineDrizzleMigrations, openBackendDb } from "./db/client.js";
import { recordDomainEvent } from "./domain/events.js";
import { type BackendConfig, loadConfig } from "./foundation/config.js";
import { operationInput, parseArguments } from "./operations/cli-args.js";
import { buildOperationsGuide, formatOperationsGuide, operationsGuideUsage } from "./operations/guide.js";
import { type OperationContext, operationCatalog, operationDef, runOperation } from "./operations/registry.js";

const CLI_ACTOR = "ops-cli";

/** The same operation run over MCP journals itself in runOpsTool; run from a
 * terminal it used to journal nothing, so the record of what changed the
 * database depended on which wire the operator reached for. Best-effort for the
 * reason that path gives: the mutation already happened, and a failed journal
 * write must not be reported as a failed operation. */
function recordCliMutation(backendDb: BackendDb | null, command: string, result: unknown): void {
  if (!backendDb) return;
  try {
    recordDomainEvent(backendDb.events, {
      ref: typeof (result as { post_key?: unknown })?.post_key === "string" ? (result as { post_key: string }).post_key : null,
      type: "operations.cli.command",
      severity: "info",
      target: "cli",
      message: `Operations CLI ${command} executed`,
      details: { operation: command },
    });
  } catch (error) {
    console.error(`operations CLI audit event failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function printHelp(): void {
  const lines = operationCatalog().map((entry) => `${entry.mutates ? "[MUTATION] " : "           "}${entry.usage}`);
  console.log(
    [
      "alexgetman backend operations",
      "",
      `           ${operationsGuideUsage().trim()}`,
      "           migrations-baseline --db PATH",
      ...lines,
      "",
      "--db PATH overrides the database; --json prints the raw result.",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    printHelp();
    return;
  }
  const dbPath = args.values.get("db") ?? process.env.PIPELINE_DB ?? "/data/pipeline.db";
  // The guide describes the catalog rather than belonging to it, and it is the
  // one command that must answer when the database cannot be opened at all.
  if (args.command === "guide") {
    const guide = buildOperationsGuide(dbPath);
    console.log(args.flags.has("json") ? JSON.stringify(guide, null, 2) : formatOperationsGuide(guide));
    return;
  }
  // Baselining writes migration bookkeeping through a raw handle, before the
  // application schema this process would otherwise expect to already exist.
  if (args.command === "migrations-baseline") {
    const sqlite = new (await import("bun:sqlite")).Database(dbPath, { strict: true }) as Parameters<typeof baselineDrizzleMigrations>[0];
    try {
      console.log(JSON.stringify({ migrations: baselineDrizzleMigrations(sqlite) }, null, 2));
    } finally {
      sqlite.close();
    }
    return;
  }
  const def = operationDef(args.command);
  if (!def) throw new Error(`unknown command: ${args.command}`);
  // Held in a cell so the lazy accessors can fill them in without TypeScript
  // losing the type across the closure boundary.
  const opened: { db: BackendDb | null; config: BackendConfig | null } = { db: null, config: null };
  const context: OperationContext = {
    dbPath,
    config: () => (opened.config ??= loadConfig({ ...process.env, PIPELINE_DB: dbPath })),
    db: () => (opened.db ??= openBackendDb(dbPath)),
    fetchImpl: fetch,
    actorType: CLI_ACTOR,
  };
  try {
    const result = await runOperation(args.command, context, operationInput(args.command, args));
    if (def.mutates) recordCliMutation(opened.db, args.command, result);
    const format = def.format;
    console.log(format && !args.flags.has("json") ? format(result as never) : JSON.stringify(result, null, 2));
  } finally {
    opened.db?.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
