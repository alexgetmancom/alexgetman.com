import { timingSafeEqual } from "node:crypto";
import type { BackendConfig } from "./config.js";

export function commandAllowed(request: Request, config: BackendConfig, payloadToken?: string | null): boolean {
  if (!config.commandCenterToken) return false;
  // A `?token=` in the URL survives in proxy access logs, Referer headers and
  // browser history, so it is accepted only for safe reads: the Command Center's
  // GET bootstrap immediately trades it for an HttpOnly cookie, and diagnostic
  // GET links keep working. Anything that changes state must present the token
  // in a header, the form body, or that cookie.
  const queryToken = isSafeMethod(request.method) ? new URL(request.url).searchParams.get("token") : null;
  const token =
    payloadToken?.trim() ||
    request.headers.get("X-Command-Token") ||
    request.headers.get("X-Admin-Token") ||
    queryToken ||
    cookieValue(request.headers.get("Cookie") ?? undefined, "command_token") ||
    "";
  return safeEqual(token, config.commandCenterToken);
}

function isSafeMethod(method: string): boolean {
  const value = method.toUpperCase();
  return value === "GET" || value === "HEAD";
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
