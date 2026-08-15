import * as z from "zod";
import { importManualAnalytics } from "../analytics/import-manual-analytics.js";
import { importXAnalyticsCsv } from "../analytics/import-x-csv.js";
import { attachXActivityToPosts } from "../analytics/x-activity-linking.js";
import { xAnalyticsReport } from "../analytics/x-activity-report.js";
import { targetDefinition } from "../botTargets.js";
import { type BackendDb, baselineDrizzleMigrations, migrationStatus, unsafeDb } from "../db/client.js";
import { recordDomainEvent } from "../domain/events.js";
import type { BackendConfig } from "../foundation/config.js";
import { log } from "../foundation/logger.js";
import { checkDataDirectoriesWritable, requiredDataDirectories } from "../foundation/runtime/data-dirs.js";
import { capabilityReport } from "../observability/capabilities.js";
import { usageReport } from "../observability/usage.js";
import { channelReport, connectChannel, disableChannel } from "./channels.js";
import { replacePublishedMedia } from "./commands/media-replacement.js";
import { doctorChecks } from "./doctor.js";
import { formatSupportSummary, recordFormatEvidence } from "./format-support.js";
import { buildOperationsGuide, formatOperationsGuide, type OperationCatalogEntry } from "./guide.js";
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
import { purgePublication } from "./publication-purge.js";
import { resolvePublicationRef } from "./publication-ref.js";
import { publishText } from "./publish.js";
import { findPublication, formatPublicationMatches, formatRecentPublications, recentPublications } from "./recent.js";
import { createOperationsService } from "./service.js";
import { settleAmbiguousTarget } from "./settle.js";
import { backfillSiteImageMedia } from "./site-media-backfill.js";
import { deduplicateSiteMedia } from "./site-media-deduplicate.js";
import { compactOperationsStatus } from "./status.js";
import { backfillTextStoryCards } from "./story-card-backfill.js";
import { loginTelegramStories } from "./telegram-stories-login.js";
import { authorizeThreads } from "./threads-authorize.js";
import { publicationTimeline } from "./timeline.js";
import { verifyPostTargets } from "./verify.js";
import { authorizeYouTube } from "./youtube-authorize.js";

/** Config and the database are resolved on demand: `restore` and
 * `migrations-baseline` operate on the file itself and must not have it opened
 * underneath them, and `guide` runs when there is no usable database at all. */
export type OperationContext = {
  dbPath: string;
  config: () => BackendConfig;
  db: () => BackendDb;
  fetchImpl: typeof fetch;
  /** Which surface is running this, for the action journal. The registry is
   * shared, so an operation cannot know it and must be told. */
  actorType: string;
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
  /** What the mutation journal attaches this run to. Defaults to the operation's
   * own normalized `--ref`; an operation whose subject no longer exists when it
   * returns says so by naming no ref. */
  journalRef?: (input: z.infer<S>) => string | null;
};

function operation<S extends z.ZodType>(def: OperationDef<S>): OperationDef<S> {
  return def;
}

// --- Shared option shapes -------------------------------------------------------

/** A usage line reading `--ref VALUE` is what sends a caller to `--ref 160`,
 * and the error it earns arrives one round-trip later. The placeholder is the
 * real invocation, and it reaches both the CLI usage line and the MCP schema. */
const example = <S extends z.ZodType>(schema: S, placeholder: string): S => schema.meta({ placeholder }) as S;

/** One line from whoever is running the command. Only operations that are off
 * the agent surface reach this, which is what makes blocking on a terminal an
 * acceptable thing for an operation to do. */
function ask(question: string): string {
  return (prompt(question) ?? "").trim();
}

/** Callers reach for the bare post number — it is what every other surface
 * shows them — so it is a spelling of the ref, not a mistake to reject. */
const refSpelling = (value: string): string => (/^\d+$/.test(value) ? `post:${value}` : value);
const refOption = example(z.string().trim().min(1), "post:160").describe("publication ref").transform(refSpelling);
const applyOption = z.boolean().default(false).describe("perform the change; omitted it reports the plan only");
const localeOption = z.enum(["ru", "en"]).optional().describe("restrict to one language");
/** Non-empty wherever it is optional: `--target=` used to reach the dispatcher
 * as the empty string, which reads as "no target given" and silently widens the
 * command to every target the publication has. An option spelled with nothing
 * after it is a mistake, and the only safe reading of it is an error. */
const targetOption = example(z.string().trim().min(1).optional(), "x").describe("restrict to one delivery target");
const commaList = (what: string) => z.string().trim().min(1).optional().describe(`comma-separated ${what}`);
const targetList = example(z.string().trim().min(1), "threads_ru")
  .describe("comma-separated exact publication targets")
  .transform((value) => splitList(value) ?? []);

function splitList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) throw new Error("a comma-separated option must name at least one value");
  return items;
}

const METRIC_BACKFILL_TARGETS = "telegram,threads_ru,threads_en,instagram_stories,instagram_stories_ru,telegram_stories";

/** The repair commands differ only in what they do to the scope they share, so
 * they share its shape too: which publication, which targets, and whether the
 * caller has seen that scope and wants it acted on. */
const repairSchema = <S extends z.ZodRawShape>(extra: S) =>
  z.object({ ref: refOption, target: targetOption, locale: localeOption, apply: applyOption, ...extra });

function runRepair(context: OperationContext, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { ref, ...rest } = input as { ref: string } & Record<string, unknown>;
  return createOperationsService(context.db(), context.config()).command(
    { action, ref, actor_type: context.actorType, ...rest },
    context.fetchImpl,
  );
}

// --- The catalog ----------------------------------------------------------------

const operationDefs = {
  guide: operation({
    summary: "Which route to run operations through, and the command catalog this build accepts.",
    schema: z.object({}),
    mutates: false,
    // Probes a host path and the launcher's local .env.local; neither is
    // meaningful to a remote caller.
    agent: false,
    note: "start here for any worker, queue, configuration or publication question",
    handler: (context) => buildOperationsGuide(context.dbPath, operationCatalog()),
    format: formatOperationsGuide,
  }),
  "migrations-baseline": operation({
    summary: "Mark this database's existing schema as migrated, without applying anything.",
    schema: z.object({}),
    mutates: true,
    // Writes migration bookkeeping through a raw handle on a host path.
    agent: false,
    handler: async (context) => {
      // Baselining precedes the application schema this process would otherwise
      // expect to already exist, so it opens the file itself rather than taking
      // the handle `context.db()` would migrate on the way out.
      const sqlite = new (await import("bun:sqlite")).Database(context.dbPath, { strict: true }) as Parameters<
        typeof baselineDrizzleMigrations
      >[0];
      try {
        return { migrations: baselineDrizzleMigrations(sqlite) };
      } finally {
        sqlite.close();
      }
    },
  }),
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
      const capabilities = capabilityReport(config, context.db());
      return {
        ok: Object.values(requiredChecks).every(Boolean) && capabilities.every((capability) => capability.status === "ready"),
        siteEnabled: config.studio.siteEnabled,
        video: config.studio.video,
        publicBaseUrl: config.PUBLIC_BASE_URL,
        checks,
        dataDirectories,
        capabilities,
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
  publish: operation({
    summary: "Create and queue one text publication for an exact target list.",
    schema: z.object({
      locale: z.enum(["ru", "en"]),
      targets: targetList,
      text: example(z.string().trim().min(1).max(20_000), '"post text"'),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => publishText(context.db(), context.config(), input),
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
    handler: (context) => channelReport(context.db()),
  }),
  "format-support": operation({
    summary: "Which media formats each target is proven to carry, and what proved it.",
    note: "About what a platform accepts, not about whether its credentials are ready — `doctor` answers that.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => formatSupportSummary(context.db()),
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
    // Pending is not a state this can report: opening the database migrates it,
    // so by the time the handler runs there is nothing left to apply.
    summary: "Schema migrations this database has applied.",
    schema: z.object({}),
    mutates: false,
    agent: true,
    handler: (context) => ({ migrations: migrationStatus(unsafeDb(context.db()).sqlite) }),
  }),
  "x-analytics": operation({
    summary:
      "What the X CSV imports hold: coverage, unlinked activity, and linkCandidates — items matching exactly one post but under the linker's 30-character bar, reported and never linked.",
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
    note: "an import runs this itself; use it after the matching rule changes, because re-importing a byte-identical CSV will not re-link anything",
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
    schema: repairSchema({}),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` queues them",
    handler: (context, input) => runRepair(context, "retry", input),
  }),
  edit: operation({
    summary: "Rewrite one locale's text, push it to the targets that can be edited and replace those that cannot.",
    schema: repairSchema({ text: example(z.string().min(1), '"new text"').describe("the replacement text") }),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` rewrites them",
    handler: (context, input) => runRepair(context, "edit", input),
  }),
  "use-other-media": operation({
    summary: "Drop one locale's own media so it falls back to the other locale's, then publish it again.",
    schema: repairSchema({}),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` republishes them",
    handler: (context, input) => runRepair(context, "use_other_media", input),
  }),
  delete: operation({
    summary: "Take a publication down from the targets that support remote deletion.",
    schema: repairSchema({ republish: z.boolean().default(false).describe("publish it again after taking it down") }),
    mutates: true,
    agent: true,
    note: "reports the targets in scope; `apply` deletes them",
    handler: (context, input) => runRepair(context, "delete", input),
  }),
  purge: operation({
    summary: "Permanently remove an already-absent Studio publication and all of its stored state.",
    schema: z.object({ ref: refOption, apply: applyOption }),
    mutates: true,
    agent: true,
    note: "reports every row in scope; set `apply` only after the remote publication is gone",
    // Purge has just deleted every event carrying this ref. Journalling the run
    // against it would put the first row of a fresh history back.
    journalRef: () => null,
    handler: (context, input) => purgePublication(context.db(), input, context.fetchImpl),
  }),
  settle: operation({
    summary: "Answer a target stuck in verification_required with what the platform actually shows.",
    note: "Reconciliation resolves an ambiguous target by asking the platform about its stored id, so a worker lost before recording one leaves nothing to ask about. Name `external-id` to record the post as live, or omit it to report the post absent and queue it again; `apply` performs it.",
    schema: z.object({
      ref: refOption,
      target: example(z.string().trim().min(1), "threads_ru").describe("the ambiguous delivery target"),
      external_id: example(z.string().trim().min(1).optional(), "18049...").describe("the id the post has on the platform, if it is there"),
      url: example(z.string().trim().min(1).optional(), "https://...").describe("its public address, if it is there"),
      apply: applyOption,
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      const backendDb = context.db();
      const resolved = resolvePublicationRef(backendDb, input.ref);
      if (!resolved) throw new Error(`publication not found: ${input.ref}`);
      return settleAmbiguousTarget(backendDb, {
        ref: resolved,
        target: input.target,
        ...(input.external_id === undefined ? {} : { externalId: input.external_id }),
        ...(input.url === undefined ? {} : { url: input.url }),
        apply: input.apply,
        actorType: context.actorType,
      });
    },
  }),
  "refresh-site": operation({
    summary: "Re-render one locale's public page without touching social targets.",
    schema: z.object({ ref: refOption, locale: localeOption }),
    mutates: true,
    agent: true,
    handler: (context, input) => runRepair(context, "refresh_site", { ...input, apply: true }),
  }),
  "replace-media": operation({
    summary: "Swap the media of a published post on one target and re-render the site.",
    schema: z.object({
      ref: refOption,
      locale: z.enum(["ru", "en"]).describe("which language's media to replace"),
      file: example(z.string().min(1), "PATH").describe("image or MP4 path on this host"),
      target: example(z.string().min(1), "threads_en").describe("the delivery target to take down and publish again"),
      apply: applyOption,
    }),
    mutates: true,
    agent: false,
    note: "reports the target in scope; `apply` replaces it",
    handler: (context, input) => replacePublishedMedia(context.db(), context.config(), input, context.fetchImpl, context.actorType),
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
        actor_type: context.actorType,
        schedule_locale: input.schedule_locale,
        at: input.at,
      }),
  }),
  "publication-repair": operation({
    summary: "Reconcile publication rows against their jobs and targets.",
    schema: z.object({
      ref: example(z.string().trim().min(1).optional(), "post:160")
        .describe("scope to one publication; omitted it sweeps everything")
        .transform((value) => (value === undefined ? undefined : refSpelling(value))),
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
      const refs = splitList(input.refs)?.map(refSpelling);
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
      sampled_at: example(z.string().min(1), "ISO").describe(
        "when the export was taken: the file's own mtime in ISO UTC, never now — it stamps the metric history",
      ),
    }),
    mutates: true,
    agent: false,
    note: "a byte-identical file is a no-op by SHA-256, so a repeat costs nothing; it links the whole table afterwards, so an older export still reaches posts written since",
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
  "format-record": operation({
    summary: "Record the message that proves a target carries a media format.",
    schema: z.object({
      test: example(z.string().min(1), "T01").describe("format test id"),
      message_id: z.coerce.number().int().describe("message that demonstrates it"),
      notes: z.string().optional(),
    }),
    mutates: true,
    agent: false,
    handler: (context, input) => ({ ok: true, status: recordFormatEvidence(context.db(), input.test, input.message_id, input.notes) }),
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
    summary: "Connect a publishing route.",
    note: "A text or story route needs only `target`: it already names the platform and the language, and asking for them again is a way to store a channel that disagrees with itself. A video account needs `platform` with `locale`.",
    schema: z.object({
      platform: example(z.string().min(1), "youtube|instagram").describe("platform to connect").optional(),
      locale: z.enum(["ru", "en"]).optional(),
      provider: example(z.string().default("native"), "native|zernio").describe("delivery provider"),
      target: z
        .enum([
          "telegram",
          "site_ru",
          "site_en",
          "threads_ru",
          "threads_en",
          "x",
          "discord",
          "telegram_stories",
          "instagram_stories_ru",
          "instagram_stories",
        ])
        .optional(),
      account_id: z.string().optional(),
      label: z.string().optional(),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => {
      // The target is the whole identity of a text or story route. Deriving
      // both from it removes the combination that stores one platform under
      // another one's id.
      const definition = input.target ? targetDefinition(input.target) : null;
      const platform = input.target ?? input.platform;
      const locale = definition?.locale ?? input.locale;
      if (!platform || !locale) throw new Error("channel-connect needs --target, or --platform with --locale");
      return connectChannel(context.db(), {
        platform,
        locale,
        provider: input.provider,
        ...(input.target ? { targetId: input.target } : {}),
        ...(input.account_id ? { providerAccountId: input.account_id } : {}),
        ...(input.label ? { label: input.label } : {}),
      });
    },
  }),
  "channel-disable": operation({
    summary: "Disable a channel, keeping its publication history attributable.",
    schema: z.object({
      channel: example(z.string().min(1), "youtube_ru").describe("channel id"),
    }),
    mutates: true,
    agent: true,
    handler: (context, input) => disableChannel(context.db(), input.channel),
  }),
  "telegram-stories-login": operation({
    summary: "Sign this Studio's Stories account in and store its session.",
    note: "Telegram Stories are posted by a user, not a bot, so the credential is an MTProto session. Needs TELEGRAM_CHANNEL_STORIES_API_ID, _API_HASH and _SESSION set first; run it with a terminal attached (docker compose exec -it) because it asks for the phone number, the code Telegram sends, and the 2FA password if the account has one.",
    schema: z.object({}),
    mutates: false,
    // Reads a phone number and a 2FA password from whoever runs it, and writes
    // a session that can post as that person.
    agent: false,
    handler: async (context) =>
      loginTelegramStories(context.config(), {
        phone: async () => ask("Phone number (with country code): "),
        code: async () => ask("Code Telegram just sent: "),
        password: async () => ask("Two-factor password (leave empty if unused): "),
      }),
  }),
  "threads-authorize": operation({
    summary: "Terminal fallback for obtaining a long-lived Threads token when the browser callback is unavailable.",
    note: "The normal path is Studio → Channels. This fallback needs THREADS_APP_ID and THREADS_APP_SECRET, prints a link, then asks for the redirect address. Run it with a terminal attached (docker compose exec -it).",
    schema: z.object({ locale: z.enum(["ru", "en"]) }),
    mutates: false,
    // Prints a credential that can post as the account.
    agent: false,
    handler: async (context, input) =>
      authorizeThreads(context.config(), input.locale, async () => ask("Address the consent screen redirected to: "), {
        fetchImpl: context.fetchImpl,
        onPrompt: (authorizeUrl, redirectUri) =>
          console.log(
            // This link deliberately carries no signed state, so the callback
            // refuses it and leaves the single-use code unspent for the
            // exchange below. The refusal page is the expected outcome here.
            `Open this and approve it as the account you publish from:\n${authorizeUrl}\n\nIt redirects to ${redirectUri}, which will report that the connection failed — that is expected on this path and the code is still good. Copy the whole address from the address bar.\n`,
          ),
      }),
  }),
  "youtube-authorize": operation({
    summary: "Obtain this Studio's YouTube refresh token by approving it on another device.",
    note: 'Needs YOUTUBE_<LOCALE>_CLIENT_ID and _CLIENT_SECRET from a Google Cloud OAuth client of type "TV and Limited Input devices". Prints a short code to enter at the URL it shows, waits for approval, then prints the refresh token to put in .env.',
    schema: z.object({ locale: z.enum(["ru", "en"]) }),
    mutates: false,
    // Prints a credential. An agent has no business holding one.
    agent: false,
    handler: async (context, input) =>
      authorizeYouTube(context.config(), input.locale, {
        fetchImpl: context.fetchImpl,
        onPrompt: (prompt) =>
          console.log(
            `Open ${prompt.verificationUrl} and enter the code ${prompt.userCode}. Waiting up to ${Math.floor(prompt.expiresInSeconds / 60)} minutes.`,
          ),
      }),
  }),
} satisfies Record<string, OperationDef>;

export function operationDef(name: string): OperationDef | undefined {
  const defs = operationDefs as Record<string, OperationDef>;
  // Own properties only: a plain lookup answers `toString` and `constructor`
  // with something inherited from Object.prototype, and the caller gets an
  // internal type error instead of "unknown command".
  return Object.hasOwn(defs, name) ? defs[name] : undefined;
}

/** What the caller wrote is wrong, as opposed to the operation having failed.
 * MCP reports it as -32602 with the offending field named and the CLI prints
 * it; both come from this one parse rather than validating a second time. */
export class OperationInputError extends Error {}

export async function runOperation(name: string, context: OperationContext, args: unknown): Promise<unknown> {
  const def = operationDef(name);
  if (!def) throw new OperationInputError(`unknown command: ${name}`);
  // Zod strips what it does not know, so a misspelled `target` used to arrive
  // as no target at all and widen a scoped command to the whole publication.
  const fields = Object.keys((inputJsonSchema(def.schema).properties ?? {}) as JsonObject);
  const given = typeof args === "object" && args !== null ? Object.keys(args as JsonObject) : [];
  const unknown = given.filter((field) => !fields.includes(field));
  if (unknown.length)
    throw new OperationInputError(
      `${name}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}; accepts ${fields.join(", ") || "no arguments"}`,
    );
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".");
    throw new OperationInputError(`${name}: ${path ? `${path}: ` : ""}${issue?.message ?? "invalid arguments"}`);
  }
  const result = await def.handler(context, parsed.data);
  if (def.mutates) journalMutation(context, name, def, parsed.data);
  return result;
}

/** Every mutation reaches the journal from here, so the record of what changed
 * the database does not depend on which surface the operator reached for, and
 * the ref it carries is the normalized one the handler actually ran against.
 * Best-effort: the mutation already happened, and reporting a failed journal
 * write as a failed operation invites a retry that publishes twice. */
function journalMutation(context: OperationContext, name: string, def: OperationDef, input: unknown): void {
  try {
    recordDomainEvent(context.db().events, {
      ref: def.journalRef ? def.journalRef(input as never) : refOf(input),
      type: "operations.command",
      severity: "info",
      target: context.actorType,
      message: `Operations ${name} executed`,
      details: { operation: name, surface: context.actorType },
    });
  } catch (error) {
    log("error", "operations audit event failed", { operation: name, surface: context.actorType, error });
  }
}

function refOf(input: unknown): string | null {
  const ref = (input as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" ? ref : null;
}

// --- Projections ----------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** A tool's client-facing schema, stripped of the document-level `$schema` key.
 * The same JSON Schema an MCP client validates against is what the CLI usage
 * line and its option list are derived from, so every surface describes one shape.
 * Described as input because that is what a caller sends: a coerced field has a
 * different output type, and publishing that would document the wrong shape. */
export function inputJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: "input" }) as JsonObject & { $schema?: unknown };
  return rest;
}

/** `--kebab-case` is the CLI spelling of a snake_case schema field. */
function optionFlag(field: string): string {
  return field.replace(/_/g, "-");
}

/** Derived, never hand-written: a usage line that drifts from the schema it
 * documents is how an operator learns the wrong invocation. */
export function operationUsage(name: string, def: OperationDef): string {
  const schema = inputJsonSchema(def.schema);
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

export function operationCatalog(): OperationCatalogEntry[] {
  return Object.entries(operationDefs as Record<string, OperationDef>).map(([name, def]) => ({
    name,
    usage: operationUsage(name, def),
    mutates: def.mutates,
    agent: def.agent,
    summary: def.summary,
    ...(def.note ? { note: def.note } : {}),
  }));
}
