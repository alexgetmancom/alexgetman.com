import { describe, expect, it } from "bun:test";
import {
  applyMutePreference,
  autoplayRejected,
  beginAutoplay,
  clearAutoplayMute,
  confirmFirstFrame,
  initialVideoAudioState,
  resetForNewStory,
} from "./audio-state.js";

describe("video audio state", () => {
  it("mutes proactively before autoplay on desktop when the user wants sound", () => {
    const state = initialVideoAudioState(false);
    const intent = beginAutoplay(state, true);
    expect(intent.muteBeforePlay).toBe(true);
    expect(intent.state.pendingDesktopSoundRestore).toBe(true);
  });

  it("does not mute proactively on mobile or when the user already muted", () => {
    expect(beginAutoplay(initialVideoAudioState(false), false).muteBeforePlay).toBe(false);
    expect(beginAutoplay(initialVideoAudioState(true), true).muteBeforePlay).toBe(false);
  });

  it("restores sound once the first frame confirms playback started", () => {
    const muted = beginAutoplay(initialVideoAudioState(false), true).state;
    const confirmation = confirmFirstFrame(muted, { isManualPaused: false, isDesktopViewport: true });
    expect(confirmation.shouldRestoreSound).toBe(true);
    expect(confirmation.state.pendingDesktopSoundRestore).toBe(false);
  });

  it("does not restore sound while paused, muted, or off desktop", () => {
    const muted = beginAutoplay(initialVideoAudioState(false), true).state;
    expect(confirmFirstFrame(muted, { isManualPaused: true, isDesktopViewport: true }).shouldRestoreSound).toBe(false);
    expect(confirmFirstFrame(muted, { isManualPaused: false, isDesktopViewport: false }).shouldRestoreSound).toBe(false);
    expect(confirmFirstFrame(applyMutePreference(true), { isManualPaused: false, isDesktopViewport: true }).shouldRestoreSound).toBe(false);
  });

  it("retries muted and marks autoplay-blocked when unmuted playback is rejected outright", () => {
    const rejection = autoplayRejected(initialVideoAudioState(false), false);
    expect(rejection.retryMuted).toBe(true);
    expect(rejection.state.videoAutoplayMuted).toBe(true);
  });

  it("marks autoplay-blocked without retrying when even the proactive muted attempt is rejected", () => {
    const muted = beginAutoplay(initialVideoAudioState(false), true).state;
    const rejection = autoplayRejected(muted, true);
    expect(rejection.retryMuted).toBe(false);
    expect(rejection.state.videoAutoplayMuted).toBe(true);
  });

  it("clears the autoplay workaround on tap-to-unmute and on story change", () => {
    const blocked = autoplayRejected(initialVideoAudioState(false), false).state;
    expect(clearAutoplayMute(blocked)).toEqual({ muted: false, videoAutoplayMuted: false, pendingDesktopSoundRestore: false });
    expect(resetForNewStory(blocked).videoAutoplayMuted).toBe(false);
    expect(resetForNewStory(blocked).muted).toBe(false);
  });
});
