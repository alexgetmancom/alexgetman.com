import type { BackendDb } from "../db/client.js";

const feedbackHits = new Map<string, number[]>();

export function mcpResponse(backendDb: BackendDb, body: unknown, clientKey: string): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, -32600, "Invalid request");
  const request = body as Record<string, unknown>;
  const id = request.id ?? null;
  if (request.method === "initialize") return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "alexgetman-blog-mcp", version: "1.0.0" } } };
  if (request.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: [{ name: "submit_feedback", description: "Send feedback or a bug report to Alex Getman.", inputSchema: { type: "object", properties: { name: { type: "string" }, message: { type: "string" } }, required: ["message"] } }] } };
  if (request.method === "tools/call") {
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    if (params.name !== "submit_feedback") return rpcError(id, -32601, `Method not found: ${String(params.name)}`);
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    const name = String(args.name || "Anonymous Agent").trim();
    const message = String(args.message || "").trim();
    if (!message) return rpcError(id, -32602, "message is required");
    if (name.length > 120 || message.length > 2000) return rpcError(id, -32602, "feedback is too long");
    if (rateLimited(clientKey)) return rpcError(id, -32000, "rate limit exceeded");
    backendDb.sqlite.prepare("INSERT INTO post_events(post_key,target,event_type,severity,message,created_at) VALUES ('mcp:feedback','mcp','mcp.feedback.received','info',?,?)")
      .run(`MCP Feedback from ${name}: ${message}`, new Date().toISOString());
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Thank you, ${name}! Your feedback has been logged.` }] } };
  }
  return { jsonrpc: "2.0", id, result: {} };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rateLimited(key: string): boolean {
  const cutoff = Date.now() - 3_600_000;
  const hits = (feedbackHits.get(key) ?? []).filter((value) => value >= cutoff);
  if (hits.length >= 5) { feedbackHits.set(key, hits); return true; }
  hits.push(Date.now()); feedbackHits.set(key, hits); return false;
}
