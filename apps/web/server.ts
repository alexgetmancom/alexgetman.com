import { createServer } from "node:http";
import { log } from "../backend/src/logger.js";
import { startRuntime, stopRuntime } from "./src/server/runtime.js";

const runtime = startRuntime();
const entry = process.env.ASTRO_DIST_ENTRY ?? "/app/dist/server/entry.mjs";
const { handler } = await import(entry);
const server = createServer(handler);

server.listen(runtime.config.PORT, runtime.config.BIND_HOST, () => {
  log("info", "Astro SSR listening", { hostname: runtime.config.BIND_HOST, port: runtime.config.PORT });
});

async function shutdown(signal: string): Promise<void> {
  server.close(async () => {
    await stopRuntime(signal);
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
