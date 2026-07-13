export function readMutedPreference(): boolean {
  try {
    return localStorage.getItem("story-player-muted") !== "false";
  } catch {
    return true;
  }
}
