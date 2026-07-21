import { timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "./config.js";

export function commandAllowed(request: Request, config: BackendConfig, payloadToken?: string | null): boolean {
  if (!config.commandCenterToken) return false;
  const token =
    payloadToken?.trim() ||
    request.headers.get("X-Command-Token") ||
    request.headers.get("X-Admin-Token") ||
    new URL(request.url).searchParams.get("token") ||
    cookieValue(request.headers.get("Cookie") ?? undefined, "command_token") ||
    "";
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

export function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
