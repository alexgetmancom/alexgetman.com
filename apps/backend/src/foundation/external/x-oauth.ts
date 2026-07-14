import crypto from "node:crypto";
import OAuth from "oauth-1.0a";
import type { BackendConfig } from "../config.js";

export function oauthAuthorization(
  method: string,
  rawUrl: string,
  config: BackendConfig,
  formParams?: URLSearchParams,
  nonce = crypto.randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const credentials = xCredentials(config);
  const oauth = new OAuth({
    consumer: { key: credentials.consumerKey, secret: credentials.consumerSecret },
    signature_method: "HMAC-SHA1",
    hash_function: (base, key) => crypto.createHmac("sha1", key).update(base).digest("base64"),
  });
  oauth.getNonce = () => nonce;
  oauth.getTimeStamp = () => timestamp;
  const data = formParams ? Object.fromEntries(formParams.entries()) : undefined;
  const authorization = oauth.authorize(
    { url: rawUrl, method: method.toUpperCase(), ...(data ? { data } : {}) },
    { key: credentials.accessToken, secret: credentials.accessTokenSecret },
  );
  return oauth.toHeader(authorization).Authorization;
}

export function assertXCredentials(config: BackendConfig): void {
  void xCredentials(config);
}

function xCredentials(config: BackendConfig) {
  if (!config.X_CONSUMER_KEY || !config.X_CONSUMER_SECRET || !config.X_ACCESS_TOKEN || !config.X_ACCESS_TOKEN_SECRET)
    throw new Error("missing X credentials");
  return {
    consumerKey: config.X_CONSUMER_KEY,
    consumerSecret: config.X_CONSUMER_SECRET,
    accessToken: config.X_ACCESS_TOKEN,
    accessTokenSecret: config.X_ACCESS_TOKEN_SECRET,
  };
}
