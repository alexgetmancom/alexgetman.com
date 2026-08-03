import { importManualAnalytics } from "./analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "./analytics/import-x-csv.js";
import { baselineDrizzleMigrations, migrationStatus, openBackendDb, unsafeDb } from "./db/client.js";
import { loadConfig } from "./foundation/config.js";
import { checkDataDirectoriesWritable, requiredDataDirectories } from "./foundation/runtime/data-dirs.js";
import { capabilityReport } from "./observability/capabilities.js";
import { usageReport } from "./observability/usage.js";
import { capabilitySummary, recordCapabilityPost } from "./operations/capabilities.js";
import { channelReport, connectChannel, disableChannel } from "./operations/channels.js";
import {
  applyMetricsBackfill,
  auditOperations,
  backupDatabase,
  buildMetricsBackfillPlan,
  publicationConsistencyReport,
  repairPublicationConsistency,
  restoreDatabase,
  withMaintenanceLock,
} from "./operations/maintenance.js";
import { diagnoseMediaProcessor, mediaJobReport, mediaProcessorStatus, reprocessPostMedia } from "./operations/media-processor.js";
import { createOperationsService } from "./operations/service.js";
import { backfillSiteImageMedia } from "./operations/site-media-backfill.js";
import { deduplicateSiteMedia } from "./operations/site-media-deduplicate.js";
import { compactOperationsStatus } from "./operations/status.js";
import { backfillTextStoryCards } from "./operations/story-card-backfill.js";
import { publicationTimeline } from "./operations/timeline.js";
import { verifyPostTargets } from "./operations/verify.js";

const republishAliases = new Set(["republish", "retry"]);

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

function required(args: Arguments, name: string): string {
  const value = args.values.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}

/** `name=value` pairs. Values reach the process through its arguments, so this
 * is meant for a shell inside the deployment, not for a shared terminal. */
function parseCredentials(pairs: string[]): Record<string, string> {
  return Object.fromEntries(
    pairs.map((pair) => {
      const separator = pair.indexOf("=");
      if (separator <= 0) throw new Error(`--credential expects name=value, received: ${pair}`);
      return [pair.slice(0, separator), pair.slice(separator + 1)];
    }),
  );
}

function printHelp(): void {
  console.log(`alexgetman backend operations

  status [--db PATH]
  migrations [--db PATH]
  migrations-baseline --db PATH
  backup [--db PATH] [--output DIRECTORY]
  restore --source PATH [--db PATH] --force
  audit [--db PATH]
  metrics-backfill [--targets a,b] [--refs post:1,post:2] [--from ISO] [--to ISO] [--apply] [--reset-counts]
  publication-repair [--apply]
  import-x-analytics --file PATH --sampled-at ISO
  import-manual-analytics [--x-file PATH] [--threads-ru-followers N] [--threads-en-followers N] [--sampled-at ISO]
  capabilities [--db PATH]
  usage [--days N] [--unused-days N] [--db PATH]
  doctor
  capability-record --test T01 --message-id 123 [--notes TEXT]
  verify --ref post:1
  timeline --ref post:1
  media-status
  media-diagnose
  media-job --ref post:1
  media-reprocess --ref post:1 [--apply]
  republish --ref post:1 [--target x] [--locale ru|en]
  retry --ref post:1 [--target x] [--locale ru|en]
  site-media-images [--apply --max-upload-kbps 6250]
  site-media-deduplicate [--apply]
  story-card-backfill --ref post:1 [--apply] [--force]
  channels
  channel-connect --platform youtube|instagram --locale ru|en [--provider native|zernio]
                  [--account-id ID] [--label TEXT] [--credential name=value ...]
  channel-disable --channel youtube_ru [--forget-credentials]`);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (["help", "--help", "-h"].includes(args.command)) {
    printHelp();
    return;
  }
  const dbPath = args.values.get("db") ?? process.env.PIPELINE_DB ?? "/data/pipeline.db";
  if (args.command === "restore") {
    restoreDatabase(required(args, "source"), dbPath, args.flags.has("force"));
    console.log(JSON.stringify({ ok: true, restored: dbPath }, null, 2));
    return;
  }
  if (args.command === "migrations-baseline") {
    const sqlite = new (await import("bun:sqlite")).Database(dbPath, { strict: true }) as Parameters<typeof baselineDrizzleMigrations>[0];
    try {
      console.log(JSON.stringify({ migrations: baselineDrizzleMigrations(sqlite) }, null, 2));
    } finally {
      sqlite.close();
    }
    return;
  }
  const config = loadConfig({ ...process.env, PIPELINE_DB: dbPath });
  const backendDb = openBackendDb(dbPath);
  try {
    if (args.command === "doctor") {
      const enabled = Object.entries(config.studio.modules)
        .filter(([, value]) => value)
        .map(([key]) => key);
      const dataDirectories = checkDataDirectoriesWritable(requiredDataDirectories(config));
      // Required: a false value here means the deployment cannot function.
      // Advisory (commandCenterToken*/webhookSecret below): informational
      // hardening status, legitimately false for e.g. a polling-only deployment
      // with no webhook secret configured — never a reason to report `ok: false`.
      const requiredChecks = {
        telegramBot: Boolean(config.controllerBotToken),
        youtube: !config.studio.modules.youtube || Boolean(config.YOUTUBE_REFRESH_TOKEN),
        instagram: !config.studio.modules.instagram || Boolean(config.INSTAGRAM_ACCESS_TOKEN && config.INSTAGRAM_USER_ID),
        dataDirectoriesWritable: dataDirectories.every((check) => check.writable),
      };
      const checks = {
        ...requiredChecks,
        commandCenterTokenConfigured: Boolean(config.COMMAND_CENTER_TOKEN),
        webhookSecretConfigured: Boolean(config.TELEGRAM_WEBHOOK_SECRET),
        commandCenterTokenSeparated: Boolean(config.COMMAND_CENTER_TOKEN && config.TELEGRAM_WEBHOOK_SECRET),
      };
      console.log(
        JSON.stringify(
          {
            ok: Object.values(requiredChecks).every(Boolean),
            modules: enabled,
            video: config.studio.video,
            publicBaseUrl: config.PUBLIC_BASE_URL,
            checks,
            dataDirectories,
            capabilities: capabilityReport(config, backendDb),
          },
          null,
          2,
        ),
      );
    } else if (args.command === "status") console.log(JSON.stringify(compactOperationsStatus(config, backendDb), null, 2));
    else if (args.command === "migrations")
      console.log(JSON.stringify({ migrations: migrationStatus(unsafeDb(backendDb).sqlite) }, null, 2));
    else if (args.command === "backup")
      console.log(JSON.stringify({ ok: true, path: await backupDatabase(backendDb, dbPath, args.values.get("output")) }, null, 2));
    else if (args.command === "audit") console.log(JSON.stringify(auditOperations(backendDb), null, 2));
    else if (args.command === "publication-repair") {
      const before = publicationConsistencyReport(backendDb);
      const repaired = args.flags.has("apply") ? repairPublicationConsistency(backendDb) : null;
      const after = repaired ? publicationConsistencyReport(backendDb) : null;
      console.log(JSON.stringify({ before, repaired, after }, null, 2));
    } else if (args.command === "metrics-backfill") {
      const targets = (
        args.values.get("targets") ?? "telegram,threads_ru,threads_en,instagram_stories,instagram_stories_ru,telegram_stories"
      )
        .split(",")
        .filter(Boolean);
      const refs = args.values.get("refs")?.split(",").filter(Boolean);
      const dateFrom = args.values.get("from");
      const dateTo = args.values.get("to");
      const plan = buildMetricsBackfillPlan(backendDb, {
        targets,
        ...(refs ? { refs } : {}),
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
      });
      const applied = args.flags.has("apply")
        ? withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, config, plan, args.flags.has("reset-counts")))
        : 0;
      console.log(JSON.stringify({ count: plan.length, applied, plan }, null, 2));
    } else if (args.command === "import-x-analytics") {
      console.log(JSON.stringify(importXAnalyticsCsv(backendDb, required(args, "file"), required(args, "sampled-at")), null, 2));
    } else if (args.command === "import-manual-analytics") {
      const xFile = args.values.get("x-file");
      const threadsRuFollowers = args.values.get("threads-ru-followers");
      const threadsEnFollowers = args.values.get("threads-en-followers");
      console.log(
        JSON.stringify(
          importManualAnalytics(backendDb, {
            sampledAt: args.values.get("sampled-at") ?? new Date().toISOString(),
            ...(xFile ? { xFile } : {}),
            ...(threadsRuFollowers == null ? {} : { threadsRuFollowers: Number(threadsRuFollowers) }),
            ...(threadsEnFollowers == null ? {} : { threadsEnFollowers: Number(threadsEnFollowers) }),
          }),
          null,
          2,
        ),
      );
    } else if (args.command === "channels") {
      console.log(JSON.stringify(channelReport(backendDb, config), null, 2));
    } else if (args.command === "channel-connect") {
      const locale = required(args, "locale");
      if (locale !== "ru" && locale !== "en") throw new Error("--locale must be ru or en");
      console.log(
        JSON.stringify(
          connectChannel(backendDb, config, {
            platform: required(args, "platform"),
            locale,
            provider: args.values.get("provider") ?? "native",
            ...(args.values.has("account-id") ? { accountId: args.values.get("account-id") as string } : {}),
            ...(args.values.has("label") ? { label: args.values.get("label") as string } : {}),
            credentials: parseCredentials(args.repeated.get("credential") ?? []),
          }),
          null,
          2,
        ),
      );
    } else if (args.command === "channel-disable") {
      console.log(JSON.stringify(disableChannel(backendDb, required(args, "channel"), args.flags.has("forget-credentials")), null, 2));
    } else if (args.command === "capabilities") {
      console.log(JSON.stringify(capabilitySummary(backendDb), null, 2));
    } else if (args.command === "usage") {
      const rawDays = args.values.get("days");
      const rawUnusedDays = args.values.get("unused-days");
      const days = rawDays == null ? undefined : Number(rawDays);
      const unusedDays = rawUnusedDays == null ? undefined : Number(rawUnusedDays);
      console.log(
        JSON.stringify(
          usageReport(backendDb, {
            ...(days === undefined ? {} : { days }),
            ...(unusedDays === undefined ? {} : { unusedDays }),
          }),
          null,
          2,
        ),
      );
    } else if (args.command === "capability-record") {
      const status = recordCapabilityPost(
        backendDb,
        required(args, "test"),
        Number(required(args, "message-id")),
        args.values.get("notes"),
      );
      console.log(JSON.stringify({ ok: true, status }, null, 2));
    } else if (args.command === "verify") console.log(JSON.stringify(await verifyPostTargets(backendDb, required(args, "ref")), null, 2));
    else if (args.command === "timeline") console.log(JSON.stringify(publicationTimeline(backendDb, required(args, "ref")), null, 2));
    else if (args.command === "media-status") console.log(JSON.stringify(await mediaProcessorStatus(config), null, 2));
    else if (args.command === "media-diagnose") console.log(JSON.stringify(await diagnoseMediaProcessor(config), null, 2));
    else if (args.command === "media-job") console.log(JSON.stringify(mediaJobReport(backendDb, required(args, "ref")), null, 2));
    else if (args.command === "media-reprocess")
      console.log(JSON.stringify(await reprocessPostMedia(backendDb, config, required(args, "ref"), args.flags.has("apply")), null, 2));
    else if (args.command === "site-media-images") {
      const rawLimit = args.values.get("max-upload-kbps");
      const maxUploadKbps = rawLimit == null ? undefined : Number(rawLimit);
      if (maxUploadKbps != null && (!Number.isFinite(maxUploadKbps) || maxUploadKbps <= 0 || maxUploadKbps > 6_250))
        throw new Error("--max-upload-kbps must be between 1 and 6250");
      console.log(JSON.stringify(await backfillSiteImageMedia(backendDb, config, args.flags.has("apply"), maxUploadKbps), null, 2));
    } else if (args.command === "site-media-deduplicate") {
      console.log(JSON.stringify(await deduplicateSiteMedia(config, args.flags.has("apply")), null, 2));
    } else if (args.command === "story-card-backfill") {
      console.log(
        JSON.stringify(
          await backfillTextStoryCards(backendDb, config, required(args, "ref"), args.flags.has("apply"), args.flags.has("force")),
          null,
          2,
        ),
      );
    } else if (republishAliases.has(args.command)) {
      const localeValue = args.values.get("locale");
      if (localeValue && localeValue !== "ru" && localeValue !== "en") throw new Error("--locale must be ru or en");
      const locale: "ru" | "en" | undefined = localeValue as "ru" | "en" | undefined;
      const result = await createOperationsService(backendDb, config).command(
        {
          action: "republish",
          ref: required(args, "ref"),
          ...(args.values.has("target") ? { target: args.values.get("target") } : {}),
          ...(locale ? { locale } : {}),
        },
        fetch,
      );
      console.log(JSON.stringify(result, null, 2));
    } else throw new Error(`unknown command: ${args.command}`);
  } finally {
    backendDb.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
