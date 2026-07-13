import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { log } from "../backend/src/logger.js";
import { startRuntime, stopRuntime } from "./src/server/runtime.js";

const runtime = startRuntime();
if (runtime.bot && !runtime.config.ENABLE_BOT_POLLING) {
  await runtime.bot.init();
  log("info", "grammY webhook bot initialized");
}
const entry = process.env.ASTRO_DIST_ENTRY ?? "/app/dist/server/entry.mjs";
const { handler } = await import(entry);

const CLIENT_DIR = path.resolve("/app/dist/client");

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer((req, res) => {
  const urlPath = req.url?.split("?")[0] || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlPath);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad request\n");
    return;
  }
  const safePath = path.normalize(decodedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(CLIENT_DIR, safePath);

  // Serve static client assets directly if they exist on disk
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control":
        safePath.startsWith("/_astro/") || safePath.startsWith("/generated/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Fallback to Astro SSR request handler
  handler(req, res);
});

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
