import { createBot } from "../../../backend/src/bot.js";
import { type BackendConfig, loadConfig } from "../../../backend/src/config.js";
import { type BackendDb, openBackendDb } from "../../../backend/src/db/client.js";
import { configureLogging, log } from "../../../backend/src/logger.js";
import { assertFfmpegAvailable, configureFfmpegConcurrency } from "../../../backend/src/runtime/ffmpeg.js";
import type { ScheduledLoop } from "../../../backend/src/scheduler.js";
import { startWorkers } from "../../../backend/src/worker.js";

type AppRuntime = { config: BackendConfig; backendDb: BackendDb; bot: ReturnType<typeof createBot>; loops: ScheduledLoop[] };

let runtime: AppRuntime | undefined;

export function startRuntime(): AppRuntime {
  if (runtime) return runtime;
  const config = loadConfig(Bun.env);
  configureLogging(config.LOG_LEVEL);
  configureFfmpegConcurrency(config.FFMPEG_MAX_CONCURRENCY);
  const backendDb = openBackendDb(config.PIPELINE_DB);
  const bot = createBot(config, backendDb);
  const loops = startWorkers(config, backendDb, bot);
  runtime = { config, backendDb, bot, loops };
  if (!assertFfmpegAvailable()) log("warn", "ffmpeg is not available; video poster generation will fail until Docker/runtime installs it");
  if (bot && config.ENABLE_BOT_POLLING) {
    void bot.start({ onStart: (botInfo) => log("info", "grammY polling started", { username: botInfo.username }) });
  }
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
  runtime = undefined;
}
