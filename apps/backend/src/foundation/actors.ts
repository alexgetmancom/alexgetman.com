import type { BackendConfig } from "./config.js";

/** The identity Studio owns work by. Drafts, media, notification settings and
 * publication history all belong to an actor, never to an interface: the same
 * actor reaches Studio through the Telegram bot on a phone and through the MCP
 * transport from an editor, and must see one shared workspace either way.
 *
 * It is a plain number because that is what the `actor_id` columns store. The
 * alias exists so signatures stop reading as "a Telegram user id" — an actor is
 * resolved *from* a credential, and Telegram is only one issuer of those. */
export type StudioActorId = number;

/** Telegram user ids are issued in the same numeric space Studio owns work by,
 * so this mapping is an identity. It is still written as a resolution step: a
 * second interface with its own id space maps here instead of teaching the core
 * about its identifiers. */
export function actorFromTelegramUser(config: BackendConfig, userId: number | undefined): StudioActorId | null {
  if (!userId || !config.ADMIN_IDS.includes(userId)) return null;
  return userId;
}

/** Resolves a bearer credential presented on the Studio transport. The token
 * authorizes exactly one actor, configured next to it. */
export function actorFromStudioToken(
  config: BackendConfig,
  token: string,
  compare: (left: string, right: string) => boolean,
): StudioActorId | null {
  if (!config.MCP_STUDIO_TOKEN || !config.MCP_STUDIO_ACTOR_ID) return null;
  return compare(token, config.MCP_STUDIO_TOKEN) ? config.MCP_STUDIO_ACTOR_ID : null;
}
