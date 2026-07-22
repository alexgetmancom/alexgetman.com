/** Tracks the story video's sound relative to the user's persisted mute
 * preference, plus the two transient workarounds autoplay policies force on
 * us. Kept as a pure state machine (mirrors discussion-state.ts) so the
 * autoplay/retry logic can be reasoned about — and tested — without a DOM. */
type VideoAudioState = {
  /** Persisted user preference; survives across stories. */
  muted: boolean;
  /** Video is forced muted after an autoplay attempt was rejected; needs a user tap to restore sound. */
  videoAutoplayMuted: boolean;
  /** We proactively muted for autoplay and are waiting for a real frame before restoring sound. */
  pendingSoundRestore: boolean;
};

export function initialVideoAudioState(muted: boolean): VideoAudioState {
  return { muted, videoAutoplayMuted: false, pendingSoundRestore: false };
}

/** The user explicitly set the mute preference (toggle or persisted default);
 * any in-flight autoplay workaround for the previous state no longer applies. */
export function applyMutePreference(muted: boolean): VideoAudioState {
  return { muted, videoAutoplayMuted: false, pendingSoundRestore: false };
}

/** A new story started rendering; autoplay workarounds never carry over. */
export function resetForNewStory(state: VideoAudioState): VideoAudioState {
  return { ...state, videoAutoplayMuted: false, pendingSoundRestore: false };
}

/** Browsers only permit automatic playback while muted, on desktop and mobile
 * alike. Mute proactively before calling `play()` and restore sound once a
 * frame actually renders (see `confirmFirstFrame`) — this is the standard
 * cross-platform trick and works on mobile Safari/Chrome too, as long as the
 * restore happens quickly (see `onvideoplaying` in StoryPlayer.svelte). */
export function beginAutoplay(state: VideoAudioState): { muteBeforePlay: boolean; state: VideoAudioState } {
  const muteBeforePlay = !state.muted;
  return { muteBeforePlay, state: muteBeforePlay ? { ...state, pendingSoundRestore: true } : state };
}

/** `play()` was rejected. `mutedBeforePlay` is whether the video element was
 * already muted going into that attempt (either we muted it in
 * `beginAutoplay`, or the persisted preference already had it muted).
 * `retryMuted: true` means the caller should force-mute and retry once. */
export function autoplayRejected(state: VideoAudioState, mutedBeforePlay: boolean): { state: VideoAudioState; retryMuted: boolean } {
  const cleared: VideoAudioState = { ...state, pendingSoundRestore: false };
  if (!mutedBeforePlay) return { state: { ...cleared, videoAutoplayMuted: true }, retryMuted: true };
  if (state.pendingSoundRestore) return { state: { ...cleared, videoAutoplayMuted: true }, retryMuted: false };
  return { state: cleared, retryMuted: false };
}

/** The first real frame played after a proactive mute. Sound should be
 * restored unless the user paused or muted in the meantime. Checked on the
 * `playing` event (not `timeupdate`) so it fires as early as possible — any
 * user-gesture-derived autoplay allowance browsers grant is short-lived, and
 * waiting longer risks the browser silently pausing playback once we unmute. */
export function confirmFirstFrame(
  state: VideoAudioState,
  context: { isManualPaused: boolean },
): { state: VideoAudioState; shouldRestoreSound: boolean } {
  if (!state.pendingSoundRestore || state.muted || context.isManualPaused) return { state, shouldRestoreSound: false };
  return { state: { ...state, pendingSoundRestore: false }, shouldRestoreSound: true };
}

/** Clears the autoplay-muted workaround once sound is actually restored,
 * whether that happened automatically (confirmFirstFrame) or because the
 * user tapped the audio-blocked control. */
export function clearAutoplayMute(state: VideoAudioState): VideoAudioState {
  return { ...state, videoAutoplayMuted: false, pendingSoundRestore: false };
}
