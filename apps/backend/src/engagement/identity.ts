import crypto from "node:crypto";
import type { BackendConfig } from "../foundation/config.js";

/** Derives a privacy-preserving public visitor identity from the trusted proxy header. */
export function clientIpHash(request: Request, config: BackendConfig): string {
  const address = config.TRUSTED_CLIENT_IP_HEADER ? request.headers.get(config.TRUSTED_CLIENT_IP_HEADER)?.trim() || "unknown" : "anonymous";
  return crypto
    .createHmac("sha256", config.LIKES_SALT || "alexgetman-likes")
    .update(address)
    .digest("hex");
}
