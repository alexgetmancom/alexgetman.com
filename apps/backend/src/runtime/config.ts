import { applyStoredApiKeys } from "../channels/api-keys.js";
import { applyStoredMetaTokens } from "../channels/meta-tokens.js";
import { applyStoredXTokens } from "../channels/x-oauth.js";
import type { BackendDb } from "../db/client.js";
import { type BackendConfig, loadConfig, withStudioProfile } from "../foundation/config.js";

/**
 * The one way to build a complete configuration: what .env states, plus what
 * this Studio's own database says about itself, plus the platform credentials
 * it renewed or connected for itself.
 *
 * Applying the stored tokens used to belong to the web server's startup, so
 * every other entry point built a configuration that was missing them. The
 * server published to X from a token in the database while `ops doctor`, a
 * separate process, reported X as an unconfigured platform — the credential had
 * one home and two answers depending on who asked.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv, backendDb: BackendDb): BackendConfig {
  const config = withStudioProfile(loadConfig(env), backendDb);
  applyStoredCredentials(config, backendDb);
  return config;
}

/**
 * Makes a running process's credentials equal to what the database holds.
 *
 * Startup is not the only moment they change: an operator connecting an account
 * or storing an API key writes the row from a separate process, and until this
 * existed the server kept publishing with the credential it read when it
 * booted — while `doctor`, reading the database, reported the new one as ready.
 * That gap published nothing at all on one Studio for half an hour, and the
 * check that should have caught it was standing on the other side of it.
 */
export function applyStoredCredentials(config: BackendConfig, backendDb: BackendDb): void {
  applyStoredMetaTokens(config, backendDb);
  applyStoredXTokens(config, backendDb);
  applyStoredApiKeys(config, backendDb);
}
