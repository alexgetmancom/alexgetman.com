import crypto from "node:crypto";
import { commandAllowed, mcpStudioActor } from "../../foundation/http-auth.js";
import { json, sse, text } from "../../foundation/http-response.js";
import { studioServices } from "../../studio/services/index.js";
import { mcpResponse } from "../mcp.js";
import type { RouteModule } from "./context.js";

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
    return json(await mcpResponse(backendDb, config, body, engagement.clientKey(c.req.raw), mcpStudioActor(c.req.raw, config)));
  });

  app.post("/api/studio/media", async (c) => {
    const request = c.req.raw;
    const actorId = mcpStudioActor(request, config);
    if (!actorId) return text("forbidden\n", 403);
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return json({ error: "Expected multipart field: file" }, 400);
    try {
      const asset = await studioServices(backendDb, config).media.import(actorId, {
        filename: file.name,
        contentType: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
        source: "http_upload",
      });
      return json({ asset_id: asset.id, kind: asset.kind, filename: asset.filename, byte_size: asset.byteSize });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
};
