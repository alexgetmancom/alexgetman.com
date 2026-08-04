import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { canAccessStudioOwner } from "../access.js";

type OwnedPublication = { actor_id: number } | { actorId: number };

/** Applies the common not-found and ownership policy to either publication model. */
export function requireOwnedPublication<T extends OwnedPublication>(
  publication: T | null,
  config: BackendConfig,
  actorId: number,
  notFoundMessage: string,
  notOwnedCode: string,
): T {
  if (!publication) throw new Error(notFoundMessage);
  const ownerId = "actorId" in publication ? publication.actorId : publication.actor_id;
  if (!canAccessStudioOwner(config, actorId, ownerId)) throw new StudioError(notOwnedCode);
  return publication;
}
