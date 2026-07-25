const MUTED_KEY = "story-player-muted";

export function readMutedPreference(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeMutedPreference(muted: boolean): void {
  try {
    localStorage.setItem(MUTED_KEY, String(muted));
  } catch {}
}
