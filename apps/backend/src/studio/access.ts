import type { BackendConfig } from "../foundation/config.js";

/** One self-hosted Studio installation is one trusted editorial boundary.
 * Every configured Studio actor can operate work created by another actor in
 * that same installation; actor IDs remain on rows for attribution and audit. */
export function studioActorIds(config: BackendConfig): number[] {
  return config.STUDIO_ACTOR_IDS.length > 0 ? config.STUDIO_ACTOR_IDS : config.ADMIN_IDS;
}

export function accessibleStudioActorIds(config: BackendConfig, actorId: number): number[] {
  const roster = studioActorIds(config);
  return roster.includes(actorId) ? roster : [actorId];
}

export function canAccessStudioOwner(config: BackendConfig, actorId: number, ownerId: number): boolean {
  return accessibleStudioActorIds(config, actorId).includes(ownerId);
}
