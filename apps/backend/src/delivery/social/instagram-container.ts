import { ExternalHttpError } from "../../foundation/http.js";

/** A Graph container that can never be published: expired, rejected, or already
 * consumed. Both the Reels and the Stories path react the same way — abandon the
 * container and build a fresh one, never retry the dead id. */
export class InstagramContainerInvalidError extends Error {}

// Meta reports a dead creation_id through several unrelated shapes: the numeric
// subcode 2207027 and a handful of prose messages that differ per endpoint and
// per API version. Keep the list in one place — the failure mode of splitting it
// is silent: one publisher learns a new code, the other keeps retrying forever.
const EXPIRED_CONTAINER_MARKERS = [
  "2207027",
  "media id is not available",
  "invalid media id",
  "invalid container",
  "creation_id",
  "container expired",
];

/** True when `error` says the container is gone. `httpStatus`, when given,
 * restricts the match to that status — media_publish only reports this class as
 * a 400, and a 500 with incidentally matching prose is a transient fault. */
export function isExpiredInstagramContainer(error: unknown, httpStatus?: number): boolean {
  if (error instanceof InstagramContainerInvalidError) return true;
  if (httpStatus != null) {
    if (!(error instanceof ExternalHttpError) || error.status !== httpStatus) return false;
    return matches(error.body ?? error.message);
  }
  return matches(error instanceof Error ? error.message : String(error));
}

function matches(body: string): boolean {
  const value = body.toLowerCase();
  return EXPIRED_CONTAINER_MARKERS.some((marker) => value.includes(marker));
}
