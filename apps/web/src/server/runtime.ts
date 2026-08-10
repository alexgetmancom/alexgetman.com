import { createBot } from "../../../backend/src/bot.js";
import { type BackendDb, openBackendDb } from "../../../backend/src/db/client.js";
import type { RawBackendDb } from "../../../backend/src/db/unsafe.js";
import { unsafeDb } from "../../../backend/src/db/unsafe.js";
import { recordDomainEvent } from "../../../backend/src/domain/events.js";
import { type BackendConfig, loadConfig } from "../../../backend/src/foundation/config.js";
import { configureLogging, log } from "../../../backend/src/foundation/logger.js";
import { checkDataDirectoriesWritable, requiredDataDirectories } from "../../../backend/src/foundation/runtime/data-dirs.js";
import { assertFfmpegAvailable, configureFfmpegConcurrency } from "../../../backend/src/foundation/runtime/ffmpeg.js";
import type { ScheduledLoop } from "../../../backend/src/foundation/scheduler.js";
import { startTelegramWorkers } from "../../../backend/src/interfaces/telegram/worker.js";
import { startCoreWorkers } from "../../../backend/src/runtime/workers.js";
import { createStudioServices, type StudioServices } from "../../../backend/src/studio/services/index.js";

type AppRuntime = {
  config: BackendConfig;
  backendDb: BackendDb;
  studio: StudioServices;
  bot: ReturnType<typeof createBot>;
  loops: ScheduledLoop[];
};

let runtime: AppRuntime | undefined;
const FFMPEG_MAX_CONCURRENCY = 2;

// Astro bundles API routes into a separate module graph from apps/web/server.ts.
// A module-local singleton therefore starts the workers twice in one Bun
// process. Keep the process singleton on globalThis so both graphs reuse it.
type RuntimeGlobal = typeof globalThis & { __alexgetmanRuntime?: AppRuntime };
const runtimeGlobal = globalThis as RuntimeGlobal;

export function startRuntime(): AppRuntime {
  // The global is authoritative, not the module-local cache: stopRuntime in one
  // module graph cannot clear the other graph's copy, and a stale copy would
  // hand out a closed database.
  runtime = runtimeGlobal.__alexgetmanRuntime;
  if (runtime) return runtime;
  const config = loadConfig(Bun.env);
  configureLogging(config.LOG_LEVEL);
  configureFfmpegConcurrency(FFMPEG_MAX_CONCURRENCY);
  const backendDb = openBackendDb(config.PIPELINE_DB);
  const studio = createStudioServices(backendDb, config);
  const bot = createBot(config, backendDb);
  const loops = config.NODE_ENV === "test" ? [] : [...startCoreWorkers(config, backendDb), ...startTelegramWorkers(config, backendDb, bot)];
  runtime = { config, backendDb, studio, bot, loops };
  runtimeGlobal.__alexgetmanRuntime = runtime;
  if (!assertFfmpegAvailable()) log("warn", "ffmpeg is not available; video poster generation will fail until Docker/runtime installs it");
  reportUnwritableDataDirectories(config, backendDb);
  return runtime;
}

/** A directory a bind-mounted volume auto-vivified for is often owned by root,
 * silently blocking the unprivileged app user until a real upload or worker
 * cycle first touches it — hours or days after the deploy that broke it. Check
 * once at boot so a misconfigured mount is loud immediately, both in logs and
 * as an admin alert, instead of surfacing as a confusing EACCES mid-request. */
function reportUnwritableDataDirectories(config: BackendConfig, backendDb: BackendDb): void {
  const unwritable = checkDataDirectoriesWritable(requiredDataDirectories(config)).filter((check) => !check.writable);
  if (!unwritable.length) return;
  const summary = unwritable.map((check) => `${check.name} (${check.path}): ${check.error}`).join("; ");
  log("error", "one or more data directories are not writable by this process", { directories: unwritable });
  recordDomainEvent(backendDb.events, {
    ref: "runtime:data-dirs",
    type: "runtime.data_directory_unwritable",
    severity: "error",
    message: `Data directory not writable: ${summary}. Check bind-mount ownership on the host.`,
    details: { directories: unwritable },
    cooldownSeconds: 60 * 60,
  });
}

export function getRuntime(): AppRuntime {
  return startRuntime();
}

/** Explicit infrastructure escape hatch for server routes that still need a raw query. */
export function unsafeRuntimeDb(): RawBackendDb {
  return unsafeDb(getRuntime().backendDb);
}

export async function stopRuntime(signal: string): Promise<void> {
  if (!runtime) return;
  log("info", "shutdown requested", { signal });
  for (const loop of runtime.loops) loop.stop();
  if (runtime.bot?.isRunning()) await runtime.bot.stop();
  runtime.backendDb.close();
  delete runtimeGlobal.__alexgetmanRuntime;
  runtime = undefined;
}
