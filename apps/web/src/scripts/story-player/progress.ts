import type { StoryPost } from "./types";

type StoryProgressControllerOptions = {
  root: HTMLElement;
  video: HTMLVideoElement | null;
  progressBars: HTMLElement[];
  currentProgressFill: HTMLElement | null;
  posts: StoryPost[];
  activeIndex: () => number;
  isPaused: () => boolean;
  onAdvance: () => void;
  intervalMs?: number;
};

export function createStoryProgressController({
  root,
  video,
  progressBars,
  currentProgressFill,
  posts,
  activeIndex,
  isPaused,
  onAdvance,
  intervalMs = 8500,
}: StoryProgressControllerOptions) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let animationTimer: number | null = null;
  let videoProgressFallbackTimer: number | null = null;
  let advanceTimer: number | null = null;
  let manualProgressTimer: number | null = null;
  let progressStartedAt = 0;
  let progressRemainingMs = intervalMs;
  let progressActive = false;
  let progressRestartBlocked = false;

  function clearTimer(timer: number | null): void {
    if (timer) window.clearTimeout(timer);
  }

  function clearVideoProgressFallback(): void {
    clearTimer(videoProgressFallbackTimer);
    videoProgressFallbackTimer = null;
  }

  function clearAdvanceTimer(): void {
    clearTimer(advanceTimer);
    advanceTimer = null;
  }

  function resetProgressFills(): void {
    progressBars.forEach((bar) => {
      const fill = bar.querySelector<HTMLElement>("i");
      if (!fill) return;
      fill.style.animation = "none";
      fill.style.animationPlayState = "running";
      fill.style.transform = "scaleY(0)";
    });
    if (currentProgressFill) {
      currentProgressFill.style.animation = "none";
      currentProgressFill.style.animationPlayState = "running";
      currentProgressFill.style.transform = "scaleX(0)";
    }
  }

  function scheduleAdvance(duration: number): void {
    clearAdvanceTimer();
    if (isPaused() || !progressActive) return;
    progressRemainingMs = Math.max(250, duration);
    progressStartedAt = Date.now();
    advanceTimer = window.setTimeout(() => {
      advanceTimer = null;
      if (!isPaused()) onAdvance();
    }, progressRemainingMs + 80);
  }

  function pauseAdvanceTimer(): void {
    if (!advanceTimer) return;
    progressRemainingMs = Math.max(250, progressRemainingMs - (Date.now() - progressStartedAt));
    clearAdvanceTimer();
  }

  function startProgressAnimation(fill: HTMLElement, duration: number): void {
    progressActive = true;
    progressRemainingMs = duration;
    fill.style.animation = "none";
    void fill.offsetHeight;
    fill.style.animation = !reduceMotion ? `storyProgressVertical ${duration}ms linear forwards` : "none";
    fill.style.animationPlayState = isPaused() ? "paused" : "running";
    if (currentProgressFill) {
      currentProgressFill.style.animation = "none";
      currentProgressFill.style.transform = "scaleX(0)";
      void currentProgressFill.offsetHeight;
      currentProgressFill.style.animation = !reduceMotion ? `storyProgressHorizontal ${duration}ms linear forwards` : "none";
      currentProgressFill.style.animationPlayState = isPaused() ? "paused" : "running";
    }
    scheduleAdvance(reduceMotion ? intervalMs : duration);
  }

  function scheduleCurrentProgress(delay = 380): void {
    if (progressRestartBlocked) return;
    const post = posts[activeIndex()];
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (!post || !fill) return;
    if (post.mediaType === "video") {
      videoProgressFallbackTimer = window.setTimeout(
        () => {
          if (posts[activeIndex()]?.mediaType === "video") startProgressAnimation(fill, intervalMs);
        },
        Math.max(delay, 700),
      );
      return;
    }
    animationTimer = window.setTimeout(() => startProgressAnimation(fill, intervalMs), delay);
  }

  function resetForStory(options: { keepProgressIdle?: boolean } = {}): void {
    clearTimer(animationTimer);
    animationTimer = null;
    clearVideoProgressFallback();
    clearAdvanceTimer();
    progressActive = false;
    progressRestartBlocked = Boolean(options.keepProgressIdle);
    resetProgressFills();
    const active = activeIndex();
    progressBars.forEach((bar, index) => {
      const fill = bar.querySelector<HTMLElement>("i");
      bar.classList.toggle("is-active", index === active);
      bar.classList.toggle("is-done", index < active);
      if (!fill) return;
      void fill.offsetHeight;
      fill.style.transform = index < active ? "scaleY(1)" : "scaleY(0)";
    });
    if (!isPaused() && !options.keepProgressIdle) scheduleCurrentProgress();
  }

  function update(paused: boolean): void {
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (fill) fill.style.animationPlayState = paused ? "paused" : "running";
    if (currentProgressFill) currentProgressFill.style.animationPlayState = paused ? "paused" : "running";
    if (progressActive) {
      if (paused) pauseAdvanceTimer();
      else if (!advanceTimer) scheduleAdvance(progressRemainingMs);
    } else if (!paused && !progressRestartBlocked && !animationTimer && !videoProgressFallbackTimer) {
      scheduleCurrentProgress(0);
    }
  }

  function resumeAfterManualNavigation(): void {
    clearTimer(manualProgressTimer);
    root.classList.add("is-manual-navigating");
    progressRestartBlocked = true;
    clearAdvanceTimer();
    clearTimer(animationTimer);
    animationTimer = null;
    clearVideoProgressFallback();
    progressActive = false;
    resetProgressFills();
    manualProgressTimer = window.setTimeout(() => {
      manualProgressTimer = null;
      root.classList.remove("is-manual-navigating");
      progressRestartBlocked = false;
      resetProgressFills();
      if (!isPaused()) scheduleCurrentProgress(260);
    }, 850);
  }

  function handleVideoPlaying(): void {
    const post = posts[activeIndex()];
    if (!video || !post || post.mediaType !== "video" || !video.currentSrc.endsWith(post.image ?? "")) return;
    clearVideoProgressFallback();
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (!fill) return;
    if (fill.style.animation && fill.style.animation !== "none") {
      fill.style.animationPlayState = isPaused() ? "paused" : "running";
      return;
    }
    startProgressAnimation(fill, video.duration ? Math.min(15000, video.duration * 1000) : intervalMs);
  }

  function handleVideoWaiting(): void {
    if (posts[activeIndex()]?.mediaType !== "video") return;
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (fill) fill.style.animationPlayState = "paused";
    if (currentProgressFill) currentProgressFill.style.animationPlayState = "paused";
  }

  return {
    resetForStory,
    update,
    resumeAfterManualNavigation,
    handleVideoPlaying,
    handleVideoWaiting,
    debugState: () => ({ progressActive, progressRestartBlocked, advanceTimer }),
  };
}
