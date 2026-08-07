import { type BackendDb, baselineDrizzleMigrations, openBackendDb } from "./db/client.js";
import { type BackendConfig, loadConfig } from "./foundation/config.js";
import { buildOperationsGuide, formatOperationsGuide, operationsGuideUsage } from "./operations/guide.js";
import {
  type OperationContext,
  operationCatalog,
  operationDef,
  operationJsonSchema,
  optionFlag,
  runOperation,
} from "./operations/registry.js";

type Arguments = { command: string; values: Map<string, string>; repeated: Map<string, string[]>; flags: Set<string> };

function parseArguments(argv: string[]): Arguments {
  const command = argv[0] ?? "help";
  const values = new Map<string, string>();
  // Options that may appear more than once, such as one --credential per value.
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      const name = token.slice(2);
      values.set(name, next);
      repeated.set(name, [...(repeated.get(name) ?? []), next]);
      index += 1;
    } else flags.add(token.slice(2));
  }
  return { command, values, repeated, flags };
}

/** Argv against the operation's own schema: a boolean field is a bare flag, an
 * array field collects its repeats, and everything else is the last value
 * given. Coercion and validation belong to the schema, not to this parser. */
function operationInput(name: string, args: Arguments): Record<string, unknown> {
  const properties = (operationJsonSchema(operationDef(name) as never).properties ?? {}) as Record<string, { type?: string }>;
  const input: Record<string, unknown> = {};
  for (const [field, property] of Object.entries(properties)) {
    const flag = optionFlag(field);
    if (property.type === "boolean") {
      if (args.flags.has(flag)) input[field] = true;
      continue;
    }
    if (property.type === "array") {
      const values = args.repeated.get(flag);
      if (values) input[field] = values;
      continue;
    }
    const value = args.values.get(flag);
    if (value !== undefined) input[field] = value;
  }
  return input;
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
  };
  try {
    const result = await runOperation(args.command, context, operationInput(args.command, args));
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
