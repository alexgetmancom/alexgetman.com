import { createBot } from "./bot.js";
import { loadConfig } from "./config.js";
import { openBackendDb } from "./db/client.js";
import { createHttpApp } from "./http.js";
import { log } from "./logger.js";
import { assertFfmpegAvailable, configureFfmpegConcurrency } from "./runtime/ffmpeg.js";
import { startWorkers } from "./worker.js";

const config = loadConfig();
configureFfmpegConcurrency(config.FFMPEG_MAX_CONCURRENCY);
const backendDb = openBackendDb(config.PIPELINE_DB);
const bot = createBot(config, backendDb);
const app = createHttpApp(config, backendDb, bot);
const loops = startWorkers(config, backendDb, bot);

if (!assertFfmpegAvailable()) {
  log("warn", "ffmpeg is not available; video poster generation will fail until Docker/runtime installs it");
}

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.BIND_HOST,
  port: config.PORT,
});
log("info", "backend listening", { hostname: config.BIND_HOST, port: config.PORT });

if (bot && config.ENABLE_BOT_POLLING) {
  void bot.start({
    onStart: (botInfo) => log("info", "grammY polling started", { username: botInfo.username }),
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  log("info", "shutdown requested", { signal });
  for (const loop of loops) {
    loop.stop();
  }
  if (bot?.isRunning()) {
    await bot.stop();
  }
  server.stop(true);
  backendDb.close();
  process.exit(0);
}

process.once("SIGINT", (signal) => {
  void shutdown(signal).catch((error) => {
    log("error", "shutdown failed", { error: String(error) });
    process.exit(1);
  });
});
process.once("SIGTERM", (signal) => {
  void shutdown(signal).catch((error) => {
    log("error", "shutdown failed", { error: String(error) });
    process.exit(1);
  });
});
