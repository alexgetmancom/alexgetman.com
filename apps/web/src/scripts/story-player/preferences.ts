const MUTED_KEY = "story-player-muted";

export function readMutedPreference(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) !== "false";
  } catch {
    return true;
  }
}

/**
 * Whether the visitor has ever answered the sound question themselves.
 *
 * readMutedPreference() cannot tell "muted because they chose to" from "muted
 * because that is the safe default", and the two need opposite treatment: the
 * first is a setting to respect silently, the second is a question still worth
 * asking, since a story's voice-over is most of its content.
 */
export function hasMutedPreference(): boolean {
  try {
    const value = localStorage.getItem(MUTED_KEY);
    return value === "true" || value === "false";
  } catch {
    return false;
  }
}

export function writeMutedPreference(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, String(muted));
  } catch {}
}
