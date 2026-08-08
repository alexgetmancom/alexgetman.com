import * as z from "zod";
import { importManualAnalytics } from "../analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "../analytics/import-x-csv.js";
import { attachXActivityToPosts } from "../analytics/x-activity-linking.js";
import { xAnalyticsReport } from "../analytics/x-activity-report.js";
import { type BackendDb, migrationStatus, unsafeDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { checkDataDirectoriesWritable, requiredDataDirectories } from "../foundation/runtime/data-dirs.js";
import { capabilityReport } from "../observability/capabilities.js";
import { usageReport } from "../observability/usage.js";
import { capabilitySummary, recordCapabilityPost } from "./capabilities.js";
import { channelReport, connectChannel, disableChannel } from "./channels.js";
import { doctorChecks } from "./doctor.js";
import {
  applyMetricsBackfill,
  auditOperations,
  backupDatabase,
  buildMetricsBackfillPlan,
  publicationConsistencyReport,
  repairPublicationConsistency,
  restoreDatabase,
  withMaintenanceLock,
} from "./maintenance.js";
import { diagnoseMediaProcessor, mediaJobReport, mediaProcessorStatus, reprocessPostMedia } from "./media-processor.js";
import { findPublication, formatPublicationMatches, formatRecentPublications, recentPublications } from "./recent.js";
import { createOperationsService } from "./service.js";
import { backfillSiteImageMedia } from "./site-media-backfill.js";
import { deduplicateSiteMedia } from "./site-media-deduplicate.js";
import { compactOperationsStatus } from "./status.js";
import { backfillTextStoryCards } from "./story-card-backfill.js";
import { publicationTimeline } from "./timeline.js";
import { verifyPostTargets } from "./verify.js";

/** Config and the database are resolved on demand: `restore` and
 * `migrations-baseline` operate on the file itself and must not have it opened
 * underneath them, and `guide` runs when there is no usable database at all. */
export type OperationContext = {
  dbPath: string;
  config: () => BackendConfig;
  db: () => BackendDb;
  fetchImpl: typeof fetch;
};

export type OperationDef<S extends z.ZodType = z.ZodType> = {
  summary: string;
  schema: S;
  mutates: boolean;
  note?: string;
  /** Projected as an MCP tool. Operations that move the database file, write
   * credentials, or read a path off the host stay CLI-only: an MCP caller is
   * remote, and none of those are meaningful — or safe — from there. */
  agent: boolean;
  handler: (context: OperationContext, input: z.infer<S>) => unknown | Promise<unknown>;
  /** Terminal rendering. Without one the result prints as JSON. */
  format?: (result: never) => string;
};

function operation<S extends z.ZodType>(def: OperationDef<S>): OperationDef<S> {
  return def;
}

// --- Shared option shapes -------------------------------------------------------

/** A usage line reading `--ref VALUE` is what sends a caller to `--ref 160`,
 * and the error it earns arrives one round-trip later. The placeholder is the
 * real invocation, and it reaches both the CLI usage line and the MCP schema. */
const example = <S extends z.ZodType>(schema: S, placeholder: string): S => schema.meta({ placeholder }) as S;

/** Callers reach for the bare post number — it is what every other surface
 * shows them — so it is a spelling of the ref, not a mistake to reject. */
const refOption = example(z.string().trim().min(1), "post:160")
  .describe("publication ref")
  .transform((value) => (/^\d+$/.test(value) ? `post:${value}` : value));
const applyOption = z.boolean().default(false).describe("perform the change; omitted it reports the plan only");
const localeOption = z.enum(["ru", "en"]).optional().describe("restrict to one language");
const targetOption = example(z.string().optional(), "x").describe("restrict to one delivery target");
const commaList = (what: string) => z.string().optional().describe(`comma-separated ${what}`);

function splitList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").filter(Boolean);
  return items?.length ? items : undefined;
}

const METRIC_BACKFILL_TARGETS = "telegram,threads_ru,threads_en,instagram_stories,instagram_stories_ru,telegram_stories";

// --- The catalog ----------------------------------------------------------------

const operationDefs = {
  status: operation({
    summary: "Worker heartbeats, publication counts and metric schedule health.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => compactOperationsStatus(context.config(), context.db()),
  }),
  doctor: operation({
    summary: "Configuration, data directories and platform credentials for this deployment.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => {
      const config = context.config();
      const dataDirectories = checkDataDirectoriesWritable(requiredDataDirectories(config));
      const { requiredChecks, checks } = doctorChecks(config, dataDirectories);
      return {
        ok: Object.values(requiredChecks).every(Boolean),
        modules: Object.entries(config.studio.modules)
          .filter(([, value]) => value)
          .map(([key]) => key),
        video: config.studio.video,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        checks,
        dataDirectories,
        capabilities: capabilityReport(config, context.db()),
      };
    },
  }),
  audit: operation({
    summary: "Failed jobs, stuck targets and publication inconsistencies across both pipelines.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => auditOperations(context.db()),
  }),
  recent: operation({
    summary: "Recent posts with their delivery targets and the targets each one is missing.",
    schema: z.object({ limit: z.coerce.number().int().min(1).max(50).default(5).describe("how many posts to report") }),
    mutates: false,
    agent: true,
    note: "start here for a delivery gap",
    handler: (context, input) => recentPublications(context.db(), input.limit),
    format: formatRecentPublications,
  }),
  find: operation({
    summary: "Resolve a publication ref from a fragment of the post text.",
    schema: z.object({ query: example(z.string().min(1), "Astra").describe("text to search for") }),
    mutates: false,
    agent: true,
    handler: (context, input) => findPublication(context.db(), input.query),
    format: formatPublicationMatches,
  }),
  verify: operation({
    summary: "Fetch every published target of one publication and report whether it is really live.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    handler: (context, input) => verifyPostTargets(context.db(), input.ref),
  }),
  timeline: operation({
    summary: "Jobs, targets and the full event log of one publication, in order.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    handler: (context, input) => publicationTimeline(context.db(), input.ref),
  }),
  channels: operation({
    summary: "Connected publishing channels and their credential state.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => channelReport(context.db(), context.config()),
  }),
  capabilities: operation({
    summary: "Platform capability tests and what each one last proved.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => capabilitySummary(context.db()),
  }),
  usage: operation({
    summary: "Which features are exercised and which have gone unused.",
    schema: z.object({
      days: z.coerce.number().int().min(1).max(365).optional().describe("window to report over"),
      unused_days: z.coerce.number().int().min(1).max(365).optional().describe("age past which a feature counts as unused"),
    }),
    mutates: false,
    agent: true,
    handler: (context, input) =>
      usageReport(context.db(), {
        ...(input.days === undefined ? {} : { days: input.days }),
        ...(input.unused_days === undefined ? {} : { unusedDays: input.unused_days }),
      }),
  }),
  migrations: operation({
    summary: "Applied and pending schema migrations.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => ({ migrations: migrationStatus(unsafeDb(context.db()).sqlite) }),
  }),
  "x-analytics": operation({
    summary: "What the X CSV imports hold: coverage, unlinked activity and posts an import declined to link.",
    schema: z.object({ limit: z.coerce.number().int().min(1).max(100).default(10).describe("how many unlinked items to list") }),
    mutates: false,
    agent: true,
    note: "run after every import-x-analytics",
    handler: (context, input) => xAnalyticsReport(context.db(), input.limit),
  }),
  "x-relink": operation({
    summary: "Attach already-imported X activity to editorial posts and project its metrics.",
    schema: z.object({ apply: applyOption }),
    mutates: true,
    agent: true,
    note: "an import runs this itself; use it after the matching rule changes",
    handler: (context, input) => attachXActivityToPosts(context.db(), input.apply),
  }),
  "media-status": operation({
    summary: "Reachability and queue depth of the media processor.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => mediaProcessorStatus(context.config(), context.fetchImpl),
  }),
  "media-diagnose": operation({
    summary: "Deeper media processor probe: codecs, storage and round-trip.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => diagnoseMediaProcessor(context.config(), context.fetchImpl),
  }),
  "media-job": operation({
    summary: "Media assets and processing state behind one publication.",
    schema: z.object({ ref: refOption }),
    mutates: false,
    agent: true,
    handler: (context, input) => mediaJobReport(context.db(), input.ref),
  }),
  retry: operation({
    summary: "Queue a publication again for a target that never went out or failed.",
    schema: z.object({ ref: refOption, target: targetOption, locale: localeOption }),
    mutates: true,
    agent: true,
    handler: (context, input) =>
      createOperationsService(context.db(), context.config()).command(
        {
          action: "republish",
          ref: input.ref,
          ...(input.target ? { target: input.target } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
        },
        context.fetchImpl,
      ),
  }),
  reschedule: operation({
    summary: "Move a scheduled publication to another time.",
    schema: z.object({
      ref: refOption,
      schedule_locale: z.enum(["ru", "en", "both"]).describe("which language's schedule to move"),
      at: example(z.string().min(1), '"06.08.2026 08:00"').describe("in the configured timezone, or an ISO instant"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) =>
      createOperationsService(context.db(), context.config()).command({
        action: "reschedule",
        ref: input.ref,
        schedule_locale: input.schedule_locale,
        at: input.at,
      }),
  }),
  "publication-repair": operation({
    summary: "Reconcile publication rows against their jobs and targets.",
    schema: z.object({
      ref: example(z.string().optional(), "post:160").describe("scope to one publication; omitted it sweeps everything"),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    note: "scoped repair is preferred",
    handler: (context, input) => {
      const backendDb = context.db();
      const options = input.ref ? { ref: input.ref } : undefined;
      const before = publicationConsistencyReport(backendDb, options);
      const repaired = input.apply ? repairPublicationConsistency(backendDb, options) : null;
      return {
        ...(input.ref ? { ref: input.ref } : {}),
        before,
        repaired,
        after: repaired ? publicationConsistencyReport(backendDb, options) : null,
      };
    },
  }),
  "media-reprocess": operation({
    summary: "Re-run media processing for one publication.",
    schema: z.object({ ref: refOption, apply: applyOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => reprocessPostMedia(context.db(), context.config(), input.ref, input.apply),
  }),
  "story-card-backfill": operation({
    summary: "Render the story card a text publication is missing.",
    schema: z.object({ ref: refOption, apply: applyOption, force: z.boolean().default(false).describe("re-render an existing card") }),
    mutates: true,
    agent: true,
    handler: (context, input) => backfillTextStoryCards(context.db(), context.config(), input.ref, input.apply, input.force),
  }),
  "metrics-backfill": operation({
    summary: "Re-sample metrics for published targets over a date range.",
    schema: z.object({
      targets: commaList("delivery targets").describe(`comma-separated delivery targets (default: ${METRIC_BACKFILL_TARGETS})`),
      refs: commaList("publication refs"),
      from: example(z.string().optional(), "ISO").describe("date lower bound"),
      to: example(z.string().optional(), "ISO").describe("date upper bound"),
      apply: applyOption,
      reset_counts: z.boolean().default(false).describe("clear existing counts before re-sampling"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      const backendDb = context.db();
      const refs = splitList(input.refs);
      const plan = buildMetricsBackfillPlan(backendDb, {
        targets: splitList(input.targets) ?? METRIC_BACKFILL_TARGETS.split(","),
        ...(refs ? { refs } : {}),
        ...(input.from ? { dateFrom: input.from } : {}),
        ...(input.to ? { dateTo: input.to } : {}),
      });
      const applied = input.apply
        ? withMaintenanceLock(backendDb, () => applyMetricsBackfill(backendDb, context.config(), plan, input.reset_counts))
        : 0;
      return { count: plan.length, applied, plan };
    },
  }),
  backup: operation({
    summary: "Copy the database to a timestamped file.",
    schema: z.object({ output: example(z.string().optional(), "DIRECTORY").describe("destination directory") }),
    mutates: true,
    agent: false,
    handler: async (context, input) => ({ ok: true, path: await backupDatabase(context.db(), context.dbPath, input.output) }),
  }),
  restore: operation({
    summary: "Replace the database with a backup.",
    schema: z.object({ source: example(z.string().min(1), "PATH").describe("backup file to restore"), force: z.boolean().default(false) }),
    mutates: true,
    agent: false,
    note: "replaces the database",
    handler: (context, input) => {
      restoreDatabase(input.source, context.dbPath, input.force);
      return { ok: true, restored: context.dbPath };
    },
  }),
  "import-x-analytics": operation({
    summary: "Import an X analytics CSV export.",
    schema: z.object({
      file: example(z.string().min(1), "PATH").describe("CSV path on this host"),
      sampled_at: example(z.string().min(1), "ISO").describe("when the export was taken"),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => importXAnalyticsCsv(context.db(), input.file, input.sampled_at),
  }),
  "import-manual-analytics": operation({
    summary: "Import hand-collected audience numbers.",
    schema: z.object({
      x_file: example(z.string().optional(), "PATH").describe("X analytics CSV path on this host"),
      threads_ru_followers: z.coerce.number().int().min(0).optional(),
      threads_en_followers: z.coerce.number().int().min(0).optional(),
      sampled_at: example(z.string().optional(), "ISO").describe("defaults to now"),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) =>
      importManualAnalytics(context.db(), {
        sampledAt: input.sampled_at ?? new Date().toISOString(),
        ...(input.x_file ? { xFile: input.x_file } : {}),
        ...(input.threads_ru_followers === undefined ? {} : { threadsRuFollowers: input.threads_ru_followers }),
        ...(input.threads_en_followers === undefined ? {} : { threadsEnFollowers: input.threads_en_followers }),
      }),
  }),
  "capability-record": operation({
    summary: "Record the message that proves a platform capability test.",
    schema: z.object({
      test: example(z.string().min(1), "T01").describe("capability test id"),
      message_id: z.coerce.number().int().describe("message that demonstrates it"),
      notes: z.string().optional(),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => ({ ok: true, status: recordCapabilityPost(context.db(), input.test, input.message_id, input.notes) }),
  }),
  "site-media-images": operation({
    summary: "Upload site images that were never pushed to media storage.",
    schema: z.object({
      apply: applyOption,
      max_upload_kbps: z.coerce.number().int().min(1).max(6_250).optional().describe("throttle the upload"),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => backfillSiteImageMedia(context.db(), context.config(), input.apply, input.max_upload_kbps),
  }),
  "site-media-deduplicate": operation({
    summary: "Collapse identical assets in media storage.",
    schema: z.object({ apply: applyOption }),
    mutates: true,
    agent: false,
    handler: (context, input) => deduplicateSiteMedia(context.config(), input.apply),
  }),
  "channel-connect": operation({
    summary: "Connect a publishing channel and store its credentials.",
    schema: z.object({
      platform: example(z.string().min(1), "youtube|instagram").describe("platform to connect"),
      locale: z.enum(["ru", "en"]),
      provider: example(z.string().default("native"), "native|zernio").describe("delivery provider"),
      account_id: z.string().optional(),
      label: z.string().optional(),
      credential: example(z.array(z.string()).default([]), "name=value").describe("repeatable"),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) =>
      connectChannel(context.db(), context.config(), {
        platform: input.platform,
        locale: input.locale,
        provider: input.provider,
        ...(input.account_id ? { accountId: input.account_id } : {}),
        ...(input.label ? { label: input.label } : {}),
        credentials: parseCredentials(input.credential),
      }),
  }),
  "channel-disable": operation({
    summary: "Disable a channel, keeping its publication history attributable.",
    schema: z.object({
      channel: example(z.string().min(1), "youtube_ru").describe("channel id"),
      forget_credentials: z.boolean().default(false),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => disableChannel(context.db(), input.channel, input.forget_credentials),
  }),
} satisfies Record<string, OperationDef>;

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

export function operationDef(name: string): OperationDef | undefined {
  return (operationDefs as Record<string, OperationDef>)[name];
}

export async function runOperation(name: string, context: OperationContext, args: unknown): Promise<unknown> {
  const def = operationDef(name);
  if (!def) throw new Error(`unknown command: ${name}`);
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new Error(`${name}: ${path ? `${path}: ` : ""}${issue?.message ?? "invalid arguments"}`);
  }
  return def.handler(context, parsed.data);
}

// --- Projections ----------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** A tool's client-facing schema, stripped of the document-level `$schema` key.
 * Described as input because that is what a caller sends: a coerced field has a
 * different output type, and publishing that would document the wrong shape. */
export function inputJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: "input" }) as JsonObject & { $schema?: unknown };
  return rest;
}

/** The same JSON Schema an MCP client validates against is what the CLI usage
 * line is derived from, so both surfaces describe one shape. */
export function operationJsonSchema(def: OperationDef): JsonObject {
  return inputJsonSchema(def.schema);
}

/** `--kebab-case` is the CLI spelling of a snake_case schema field. */
export function optionFlag(field: string): string {
  return field.replace(/_/g, "-");
}

/** Derived, never hand-written: a usage line that drifts from the schema it
 * documents is how an operator learns the wrong invocation. */
export function operationUsage(name: string, def: OperationDef): string {
  const schema = operationJsonSchema(def);
  const properties = (schema.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const parts = Object.entries(properties).map(([field, property]) => {
    const flag = optionFlag(field);
    const enumValues = property.enum as string[] | undefined;
    const placeholder = (property.placeholder as string | undefined) ?? (enumValues ? enumValues.join("|") : "VALUE");
    const token =
      property.type === "boolean" ? `--${flag}` : property.type === "array" ? `--${flag} ${placeholder} ...` : `--${flag} ${placeholder}`;
    return required.has(field) ? token : `[${token}]`;
  });
  return [name, ...parts].join(" ");
}

export type OperationCatalogEntry = { name: string; usage: string; mutates: boolean; agent: boolean; summary: string; notes?: string };

export function operationCatalog(): OperationCatalogEntry[] {
  return Object.entries(operationDefs as Record<string, OperationDef>).map(([name, def]) => ({
    name,
    usage: operationUsage(name, def),
    mutates: def.mutates,
    agent: def.agent,
    summary: def.summary,
    ...(def.note ? { notes: def.note } : {}),
  }));
}
