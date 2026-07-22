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
  it("mutes proactively before autoplay when the user wants sound", () => {
    const state = initialVideoAudioState(false);
    const intent = beginAutoplay(state);
    expect(intent.muteBeforePlay).toBe(true);
    expect(intent.state.pendingSoundRestore).toBe(true);
  });

  it("does not mute proactively when the user already muted", () => {
    expect(beginAutoplay(initialVideoAudioState(true)).muteBeforePlay).toBe(false);
  });

  it("restores sound once the first frame confirms playback started", () => {
    const muted = beginAutoplay(initialVideoAudioState(false)).state;
    const confirmation = confirmFirstFrame(muted, { isManualPaused: false });
    expect(confirmation.shouldRestoreSound).toBe(true);
    expect(confirmation.state.pendingSoundRestore).toBe(false);
  });

  it("does not restore sound while paused or muted", () => {
    const muted = beginAutoplay(initialVideoAudioState(false)).state;
    expect(confirmFirstFrame(muted, { isManualPaused: true }).shouldRestoreSound).toBe(false);
    expect(confirmFirstFrame(applyMutePreference(true), { isManualPaused: false }).shouldRestoreSound).toBe(false);
  });

  it("retries muted and marks autoplay-blocked when unmuted playback is rejected outright", () => {
    const rejection = autoplayRejected(initialVideoAudioState(false), false);
    expect(rejection.retryMuted).toBe(true);
    expect(rejection.state.videoAutoplayMuted).toBe(true);
  });

  it("marks autoplay-blocked without retrying when even the proactive muted attempt is rejected", () => {
    const muted = beginAutoplay(initialVideoAudioState(false)).state;
    const rejection = autoplayRejected(muted, true);
    expect(rejection.retryMuted).toBe(false);
    expect(rejection.state.videoAutoplayMuted).toBe(true);
  });

  it("clears the autoplay workaround on tap-to-unmute and on story change", () => {
    const blocked = autoplayRejected(initialVideoAudioState(false), false).state;
    expect(clearAutoplayMute(blocked)).toEqual({ muted: false, videoAutoplayMuted: false, pendingSoundRestore: false });
    expect(resetForNewStory(blocked).videoAutoplayMuted).toBe(false);
    expect(resetForNewStory(blocked).muted).toBe(false);
  });
});
