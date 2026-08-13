import type { APIRoute } from "astro";
import { siteUrlFromContext } from "../../../utils/site";

/** Server card for MCP clients that discover a server before connecting. */
export const prerender = false;

export const GET: APIRoute = (context) => {
  const site = siteUrlFromContext(context);
  const body = {
    $schema: "https://modelcontextprotocol.io/schemas/server-card/v1.0",
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: { name: "solo-publisher-feed-mcp", version: "1.0.0" },
    description: `MCP server exposing ${new URL(site).host} feed items and analytics.`,
    transport: { type: "streamable-http", endpoint: "/feed.json" },
    capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
    authentication: { required: false },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
