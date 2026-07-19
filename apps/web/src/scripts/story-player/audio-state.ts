/** Tracks the story video's sound relative to the user's persisted mute
 * preference, plus the two transient workarounds autoplay policies force on
 * us. Kept as a pure state machine (mirrors discussion-state.ts) so the
 * autoplay/retry logic can be reasoned about — and tested — without a DOM. */
export type VideoAudioState = {
  /** Persisted user preference; survives across stories. */
  muted: boolean;
  /** Video is forced muted after an autoplay attempt was rejected; needs a user tap to restore sound. */
  videoAutoplayMuted: boolean;
  /** We proactively muted for autoplay on desktop and are waiting for a real frame before restoring sound. */
  pendingDesktopSoundRestore: boolean;
};

export function initialVideoAudioState(muted: boolean): VideoAudioState {
  return { muted, videoAutoplayMuted: false, pendingDesktopSoundRestore: false };
}

/** The user explicitly set the mute preference (toggle or persisted default);
 * any in-flight autoplay workaround for the previous state no longer applies. */
export function applyMutePreference(muted: boolean): VideoAudioState {
  return { muted, videoAutoplayMuted: false, pendingDesktopSoundRestore: false };
}

/** A new story started rendering; autoplay workarounds never carry over. */
export function resetForNewStory(state: VideoAudioState): VideoAudioState {
  return { ...state, videoAutoplayMuted: false, pendingDesktopSoundRestore: false };
}

/** Chromium only permits automatic playback while muted. On desktop, where
 * users expect sound by default, mute proactively before calling `play()`
 * and restore sound once a frame actually renders (see `confirmFirstFrame`). */
export function beginAutoplay(state: VideoAudioState, isDesktopViewport: boolean): { muteBeforePlay: boolean; state: VideoAudioState } {
  const muteBeforePlay = !state.muted && isDesktopViewport;
  return { muteBeforePlay, state: muteBeforePlay ? { ...state, pendingDesktopSoundRestore: true } : state };
}

/** `play()` was rejected. `mutedBeforePlay` is whether the video element was
 * already muted going into that attempt (either we muted it in
 * `beginAutoplay`, or the persisted preference already had it muted).
 * `retryMuted: true` means the caller should force-mute and retry once. */
export function autoplayRejected(state: VideoAudioState, mutedBeforePlay: boolean): { state: VideoAudioState; retryMuted: boolean } {
  const cleared: VideoAudioState = { ...state, pendingDesktopSoundRestore: false };
  if (!mutedBeforePlay) return { state: { ...cleared, videoAutoplayMuted: true }, retryMuted: true };
  if (state.pendingDesktopSoundRestore) return { state: { ...cleared, videoAutoplayMuted: true }, retryMuted: false };
  return { state: cleared, retryMuted: false };
}

/** The first real frame played after a proactive desktop mute. Sound should
 * be restored unless the user paused, muted, or navigated away in the meantime. */
export function confirmFirstFrame(
  state: VideoAudioState,
  context: { isManualPaused: boolean; isDesktopViewport: boolean },
): { state: VideoAudioState; shouldRestoreSound: boolean } {
  if (!state.pendingDesktopSoundRestore || state.muted || context.isManualPaused || !context.isDesktopViewport)
    return { state, shouldRestoreSound: false };
  return { state: { ...state, pendingDesktopSoundRestore: false }, shouldRestoreSound: true };
}

/** Clears the autoplay-muted workaround once sound is actually restored,
 * whether that happened automatically (confirmFirstFrame) or because the
 * user tapped the audio-blocked control. */
export function clearAutoplayMute(state: VideoAudioState): VideoAudioState {
  return { ...state, videoAutoplayMuted: false, pendingDesktopSoundRestore: false };
}
