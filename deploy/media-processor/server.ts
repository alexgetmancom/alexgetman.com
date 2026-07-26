import { createMediaProcessor } from "./service.ts";

/** Bootstrap only: read the environment, bind the port. Everything the service
 * actually does lives in service.ts, where it can be tested. */
const processor = createMediaProcessor({
  token: Bun.env.MEDIA_PROCESSOR_TOKEN ?? "",
  // The compose file mounts the VM's work volume at /work; the override exists
  // so this exact bootstrap can be started outside the image.
  workDir: Bun.env.MEDIA_PROCESSOR_WORK_DIR ?? "/work",
  maxBytes: Number(Bun.env.MEDIA_PROCESSOR_MAX_BYTES ?? 1_073_741_824),
  timeoutSeconds: Number(Bun.env.MEDIA_PROCESSOR_TIMEOUT_SECONDS ?? 900),
  cacheTtlSeconds: Number(Bun.env.MEDIA_PROCESSOR_CACHE_TTL_SECONDS ?? 86_400),
  revision: Bun.env.MEDIA_PROCESSOR_REVISION,
});

setInterval(() => processor.pruneWorkDir(), 60 * 60 * 1000).unref();

Bun.serve({
  port: 8787,
  hostname: "0.0.0.0",
  fetch: (request) => processor.handle(request),
});
