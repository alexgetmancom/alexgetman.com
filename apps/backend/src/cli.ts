import { loadConfig } from "./config.js";
import { openBackendDb } from "./db/client.js";
import { pipelineStatusPayload } from "./services/pipeline.js";
import { applyMetricsBackfill, auditOperations, backupDatabase, buildMetricsBackfillPlan, restoreDatabase, withMaintenanceLock } from "./ops/maintenance.js";
import { capabilitySummary, recordCapabilityPost, seedCapabilities } from "./ops/capabilities.js";
import { verifyPostTargets } from "./ops/verify.js";

type Arguments = { command: string; values: Map<string, string>; flags: Set<string> };

function parseArguments(argv: string[]): Arguments {
  const command = argv[0] ?? "help";
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { values.set(token.slice(2), next); index += 1; }
    else flags.add(token.slice(2));
  }
  return { command, values, flags };
}

function required(args: Arguments, name: string): string {
  const value = args.values.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

function printHelp(): void {
  console.log(`alexgetman backend operations

  status [--db PATH]
  backup [--db PATH] [--output DIRECTORY]
  restore --source PATH [--db PATH] --force
  audit [--db PATH]
  metrics-backfill [--targets a,b] [--refs post:1,post:2] [--from ISO] [--to ISO] [--apply] [--reset-counts]
  capabilities [--db PATH]
  capability-record --test T01 --message-id 123 [--notes TEXT]
  verify --ref post:1`);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) { printHelp(); return; }
  const dbPath = args.values.get("db") ?? process.env.PIPELINE_DB ?? "/data/pipeline.db";
  if (args.command === "restore") {
    restoreDatabase(required(args, "source"), dbPath, args.flags.has("force"));
    console.log(JSON.stringify({ ok: true, restored: dbPath }, null, 2));
    return;
  }
  const config = loadConfig({ ...process.env, PIPELINE_DB: dbPath });
  const backendDb = openBackendDb(dbPath);
  try {
    if (args.command === "status") console.log(JSON.stringify(pipelineStatusPayload(config, backendDb), null, 2));
    else if (args.command === "backup") console.log(JSON.stringify({ ok: true, path: await backupDatabase(backendDb, dbPath, args.values.get("output")) }, null, 2));
    else if (args.command === "audit") console.log(JSON.stringify(auditOperations(backendDb), null, 2));
    else if (args.command === "metrics-backfill") {
      const targets = (args.values.get("targets") ?? "telegram,threads_ru,threads_en,facebook,facebook_ru,devto,bluesky,mastodon,github_en,github_ru,instagram_stories,instagram_stories_ru,telegram_stories").split(",").filter(Boolean);
      const refs = args.values.get("refs")?.split(",").filter(Boolean);
      const dateFrom = args.values.get("from");
      const dateTo = args.values.get("to");
      const plan = buildMetricsBackfillPlan(backendDb, { targets, ...(refs ? { refs } : {}), ...(dateFrom ? { dateFrom } : {}), ...(dateTo ? { dateTo } : {}) });
      const applied = args.flags.has("apply") ? withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, plan, args.flags.has("reset-counts"))) : 0;
      console.log(JSON.stringify({ count: plan.length, applied, plan }, null, 2));
    } else if (args.command === "capabilities") {
      seedCapabilities(backendDb);
      console.log(JSON.stringify(capabilitySummary(backendDb), null, 2));
    } else if (args.command === "capability-record") {
      const status = recordCapabilityPost(backendDb, required(args, "test"), Number(required(args, "message-id")), args.values.get("notes"));
      console.log(JSON.stringify({ ok: true, status }, null, 2));
    } else if (args.command === "verify") console.log(JSON.stringify(await verifyPostTargets(backendDb, required(args, "ref")), null, 2));
    else throw new Error(`unknown command: ${args.command}`);
  } finally {
    backendDb.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
