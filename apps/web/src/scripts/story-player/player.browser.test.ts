import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { createStoryViewTracker } from "./analytics.js";
import { setDiscussionVisibility } from "./discussion-state.js";
import { preloadAdjacentMedia } from "./media.js";
import { readMutedPreference } from "./preferences.js";
import { createStoryProgressController } from "./progress.js";
import type { StoryPost } from "./types.js";

const originalGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  Image: globalThis.Image,
  navigator: globalThis.navigator,
};
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function installDom(url = "https://example.test/stories/"): Window {
  const window = new Window({ url });
  Object.assign(globalThis, {
    window,
    document: window.document,
    Image: window.Image,
    navigator: window.navigator,
  });
  return window;
}

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
  if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

function post(overrides: Partial<StoryPost> = {}): StoryPost {
  return {
    url: "/stories/example/",
    image: "media/posts/example.jpg",
    mediaType: "image",
    title: "Example",
    category: "News",
    relativeDate: "now",
    ...overrides,
  };
}

/** Mirrors StoryPlayer.svelte's normalizedPath — turns a post url into a comparable pathname. */
function normalizedPath(value: string): string {
  try {
    const url = new URL(value, window.location.origin);
    return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  } catch {
    return "/";
  }
}

function stubSendBeacon(window: Window): string[] {
  const calls: string[] = [];
  (window.navigator as any).sendBeacon = (url: string) => {
    calls.push(url);
    return true;
  };
  return calls;
}

describe("story player browser behavior", () => {
  it("pauses for discussion and restores the preceding manual pause state", () => {
    expect(setDiscussionVisibility({ visible: false, isManualPaused: false, manualPausedBeforeDiscussion: false }, true)).toEqual({
      visible: true,
      isManualPaused: true,
      manualPausedBeforeDiscussion: false,
    });
    expect(setDiscussionVisibility({ visible: true, isManualPaused: true, manualPausedBeforeDiscussion: false }, false)).toEqual({
      visible: false,
      isManualPaused: false,
      manualPausedBeforeDiscussion: false,
    });
    expect(setDiscussionVisibility({ visible: true, isManualPaused: true, manualPausedBeforeDiscussion: true }, false).isManualPaused).toBe(
      true,
    );
  });

  it("does not advance a buffering video until playback resumes", async () => {
    const window = installDom();
    const video = window.document.createElement("video") as unknown as HTMLVideoElement;
    const posts = [post({ image: "/media/posts/example.mp4", mediaType: "video" })];
    let advances = 0;
    const progress = createStoryProgressController({
      getVideo: () => video,
      getProgressFill: () => null,
      posts,
      activeIndex: () => 0,
      isPaused: () => false,
      onAdvance: () => advances++,
      intervalMs: 250,
    });

    progress.resetForStory();
    await Bun.sleep(720);
    expect(progress.debugState().advanceTimer).not.toBeNull();
    progress.handleVideoWaiting();
    expect(progress.debugState().advanceTimer).toBeNull();
    await Bun.sleep(400);
    expect(advances).toBe(0);
  });

  it("tracks video completion even when the <video> element mounts after the controller is created", async () => {
    const window = installDom();
    const posts = [post({ image: "/media/posts/example.mp4", mediaType: "video" })];
    let currentVideo: HTMLVideoElement | null = null;
    let advances = 0;
    const progress = createStoryProgressController({
      getVideo: () => currentVideo,
      getProgressFill: () => null,
      posts,
      activeIndex: () => 0,
      isPaused: () => false,
      onAdvance: () => advances++,
      intervalMs: 250,
    });

    progress.resetForStory();
    // Svelte's {#if isVideo} block mounts a fresh <video> node after the controller
    // already exists — getVideo() must observe it, unlike a value captured once.
    currentVideo = window.document.createElement("video") as unknown as HTMLVideoElement;
    Object.defineProperty(currentVideo, "duration", { value: 10, configurable: true });
    Object.defineProperty(currentVideo, "currentTime", { value: 0, configurable: true });

    progress.handleVideoPlaying();
    await Bun.sleep(400);
    expect(advances).toBe(0);
    progress.handleVideoEnded();
    expect(advances).toBe(1);
  });

  it("preloads a relative video URL as a public absolute-path URL", () => {
    const window = installDom();
    const createdVideos: Array<{ src: string }> = [];
    const createElement = window.document.createElement.bind(window.document);
    window.document.createElement = ((tagName: string) => {
      const element = createElement(tagName);
      if (tagName === "video") createdVideos.push(element as unknown as { src: string });
      return element;
    }) as typeof document.createElement;

    preloadAdjacentMedia({
      active: 0,
      posts: [post(), post({ image: "media/posts/next.mp4", mediaType: "video" }), post({ image: "media/posts/later.jpg" })],
      // Payload заранее нормализует пути; воспроизводим то же преобразование.
      toPublicSrc: (value) => (value ? (/^(https?:|data:|blob:|\/)/i.test(value) ? value : `/${value.replace(/^\/+/, "")}`) : ""),
    });

    expect(createdVideos).toHaveLength(1);
    expect(createdVideos[0]?.src).toBe("https://example.test/media/posts/next.mp4");
  });

  it("uses the safe default when localStorage is unavailable", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("storage blocked");
      },
    });
    expect(readMutedPreference()).toBe(true);
  });

  it("holds auto-progress during manual navigation before restarting it", async () => {
    installDom();
    let advances = 0;
    const progress = createStoryProgressController({
      getVideo: () => null,
      getProgressFill: () => null,
      posts: [post()],
      activeIndex: () => 0,
      isPaused: () => false,
      onAdvance: () => advances++,
      intervalMs: 250,
    });

    progress.resetForStory({ keepProgressIdle: true });
    progress.resumeAfterManualNavigation();
    expect(progress.debugState()).toEqual(expect.objectContaining({ progressRestartBlocked: true, advanceTimer: null }));
    await Bun.sleep(600);
    expect(advances).toBe(0);
    await Bun.sleep(650);
    expect(progress.debugState().progressRestartBlocked).toBe(false);
    await Bun.sleep(300);
    expect(advances).toBe(1);
  });

  it("does not record a story view when running on localhost", async () => {
    const window = installDom("http://localhost:4321/");
    const beacons = stubSendBeacon(window);
    const tracker = createStoryViewTracker({ activeIndex: () => 0, normalizedPath });

    tracker.scheduleStoryView(post({ url: "/stories/other/" }));
    await Bun.sleep(2100);
    expect(beacons).toHaveLength(0);
  });

  it("does not record a view for the post already being viewed", async () => {
    const window = installDom("https://example.test/stories/example/");
    const beacons = stubSendBeacon(window);
    const tracker = createStoryViewTracker({ activeIndex: () => 0, normalizedPath });

    tracker.scheduleStoryView(post({ url: "/stories/example/" }));
    await Bun.sleep(2100);
    expect(beacons).toHaveLength(0);
  });

  it("records a story view once via sendBeacon, deduped by sessionStorage on repeat", async () => {
    const window = installDom("https://example.test/stories/");
    const beacons = stubSendBeacon(window);
    const tracker = createStoryViewTracker({ activeIndex: () => 0, normalizedPath });

    tracker.scheduleStoryView(post({ url: "/stories/other/", id: "post-1" }));
    await Bun.sleep(2100);
    expect(beacons).toEqual(["/stats/pageview"]);

    tracker.scheduleStoryView(post({ url: "/stories/other/", id: "post-1" }));
    await Bun.sleep(2100);
    expect(beacons).toHaveLength(1);
  });

  it("cancels the pending view if the active post changed before the 2s timer fires", async () => {
    const window = installDom("https://example.test/stories/");
    const beacons = stubSendBeacon(window);
    let active = 0;
    const tracker = createStoryViewTracker({ activeIndex: () => active, normalizedPath });

    tracker.scheduleStoryView(post({ url: "/stories/other/" }));
    active = 1;
    await Bun.sleep(2100);
    expect(beacons).toHaveLength(0);
  });
});
