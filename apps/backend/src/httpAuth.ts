import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "./config.js";

export function commandAllowed(c: Context, config: BackendConfig, payloadToken?: string | null): boolean {
  if (c.req.header("X-Authenticated-User")) return true;
  if (!config.commandCenterToken) return false;
  const token = payloadToken?.trim() || c.req.header("X-Command-Token") || c.req.header("X-Admin-Token") || new URL(c.req.url).searchParams.get("token") || cookieValue(c.req.header("Cookie"), "command_token") || "";
  return safeEqual(token, config.commandCenterToken);
}

function cookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) return "";
  for (const chunk of cookieHeader.split(";")) {
    const [key, ...value] = chunk.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
