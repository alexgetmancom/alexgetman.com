import { loadConfig } from "../config.js";
import { openBackendDb } from "../db/client.js";
import { log } from "../logger.js";
import { runSiteJobCycle } from "./jobs.js";

const config = loadConfig({ ...process.env, SITE_BUILDER_MODE: "true" });
const backendDb = openBackendDb(config.PIPELINE_DB);
let stopping = false;
let running = false;

async function tick(): Promise<void> {
  if (stopping || running) return;
  running = true;
  try {
    const claimed = await runSiteJobCycle(config, backendDb);
    log("debug", "site builder tick", { claimed });
  } catch (error) {
    log("error", "site builder tick failed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  backendDb.close();
  log("info", "site builder stopped", { signal });
}

const interval = setInterval(() => void tick(), config.METRICS_REFRESH_INTERVAL_SECONDS * 1000);
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
await tick();
