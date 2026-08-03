import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { importStudioMediaFile } from "../../content/assets.js";
import { commandAllowed, mcpStudioActor } from "../../foundation/http-auth.js";
import { json, sse, text } from "../../foundation/http-response.js";
import { trackUsageAsync } from "../../observability/usage.js";
import { mcpResponse } from "../mcp.js";
import type { RouteModule } from "./context.js";
import { isMediaUploadTooLarge, MediaUploadTooLargeError, streamUploadToFile } from "./media-upload.js";

let activeMediaUploads = 0;

export const studioRoutes: RouteModule = (app, { config, backendDb, engagement }) => {
  // The MCP transport is a privileged Studio surface, same as POST /api/mcp:
  // an unauthenticated stream let any client pin an open connection and a
  // recurring timer for free.
  app.get("/api/mcp", (c) => {
    if (!mcpStudioActor(c.req.raw, config) && !commandAllowed(c.req.raw, config)) return text("unauthorized\n", 401);
    return sse((send) => {
      send("endpoint", `/api/mcp?connection_id=${crypto.randomUUID()}`);
      return setInterval(() => send("ping", new Date().toISOString()), 30_000);
    });
  });

  app.post("/api/mcp", async (c) => {
    const body = await c.req.raw.json().catch(() => null);
    if (body == null) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    return json(
      await trackUsageAsync(backendDb, "studio.mcp.request", () =>
        mcpResponse(backendDb, config, body, engagement.clientKey(c.req.raw), mcpStudioActor(c.req.raw, config)),
      ),
    );
  });

  app.post("/api/studio/media", async (c) => {
    const request = c.req.raw;
    const actorId = mcpStudioActor(request, config);
    if (!actorId) return text("forbidden\n", 403);
    if (activeMediaUploads >= config.STUDIO_UPLOAD_CONCURRENCY) {
      return json({ error: "Too many media uploads are active; retry shortly." }, 429, { "retry-after": "30" });
    }
    activeMediaUploads += 1;
    try {
      const contentType = ((request.headers.get("content-type") ?? "application/octet-stream").split(";", 1)[0] ?? "").trim().toLowerCase();
      if (contentType === "multipart/form-data")
        return json({ error: "Upload the raw file body with X-Filename and Content-Type headers." }, 415);
      const body = request.body;
      if (!body) return json({ error: "Media request has no body" }, 400);
      const temporaryDirectory = path.join(config.STUDIO_MEDIA_DIR, ".incoming");
      const temporary = path.join(temporaryDirectory, crypto.randomUUID());
      await fs.promises.mkdir(temporaryDirectory, { recursive: true });
      let asset: Awaited<ReturnType<typeof importStudioMediaFile>>;
      try {
        const contentLength = Number(request.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > config.STUDIO_MEDIA_MAX_BYTES)
          throw new MediaUploadTooLargeError(config.STUDIO_MEDIA_MAX_BYTES);
        const byteSize = await streamUploadToFile(body, temporary, config.STUDIO_MEDIA_MAX_BYTES);
        asset = await importStudioMediaFile(backendDb, config, actorId, {
          filename: request.headers.get("x-filename") ?? request.headers.get("x-file-name") ?? "upload",
          contentType,
          localPath: temporary,
          byteSize,
          source: "http_upload",
        });
      } finally {
        await fs.promises.rm(temporary, { force: true });
      }
      return json({ asset_id: asset.id, kind: asset.kind, filename: asset.filename, byte_size: asset.byteSize });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, isMediaUploadTooLarge(error) ? 413 : 400);
    } finally {
      activeMediaUploads -= 1;
    }
  });
};
