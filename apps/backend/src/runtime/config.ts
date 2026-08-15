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
  applyStoredMetaTokens(config, backendDb);
  applyStoredXTokens(config, backendDb);
  applyStoredApiKeys(config, backendDb);
  return config;
}
