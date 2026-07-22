import { createBot } from "../../../backend/src/bot.js";
import { type BackendDb, openBackendDb } from "../../../backend/src/db/client.js";
import { type BackendConfig, loadConfig } from "../../../backend/src/foundation/config.js";
import { configureLogging, log } from "../../../backend/src/foundation/logger.js";
import { assertFfmpegAvailable, configureFfmpegConcurrency } from "../../../backend/src/foundation/runtime/ffmpeg.js";
import type { ScheduledLoop } from "../../../backend/src/foundation/scheduler.js";
import { startTelegramWorkers } from "../../../backend/src/interfaces/telegram/worker.js";
import { startCoreWorkers } from "../../../backend/src/runtime/workers.js";

type AppRuntime = { config: BackendConfig; backendDb: BackendDb; bot: ReturnType<typeof createBot>; loops: ScheduledLoop[] };

let runtime: AppRuntime | undefined;

// Astro bundles API routes into a separate module graph from apps/web/server.ts.
// A module-local singleton therefore starts the workers twice in one Bun
// process. Keep the process singleton on globalThis so both graphs reuse it.
type RuntimeGlobal = typeof globalThis & { __alexgetmanRuntime?: AppRuntime };
const runtimeGlobal = globalThis as RuntimeGlobal;

export function startRuntime(): AppRuntime {
  runtime ??= runtimeGlobal.__alexgetmanRuntime;
  if (runtime) return runtime;
  const config = loadConfig(Bun.env);
  configureLogging(config.LOG_LEVEL);
  configureFfmpegConcurrency(config.FFMPEG_MAX_CONCURRENCY);
  const backendDb = openBackendDb(config.PIPELINE_DB);
  const bot = createBot(config, backendDb);
  const loops = [...startCoreWorkers(config, backendDb), ...startTelegramWorkers(config, backendDb, bot)];
  runtime = { config, backendDb, bot, loops };
  runtimeGlobal.__alexgetmanRuntime = runtime;
  if (!assertFfmpegAvailable()) log("warn", "ffmpeg is not available; video poster generation will fail until Docker/runtime installs it");
  return runtime;
}

export function getRuntime(): AppRuntime {
  return startRuntime();
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
