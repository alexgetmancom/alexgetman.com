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
  let videoDriven = false;

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

  function setProgress(fraction: number): void {
    const progress = Math.min(1, Math.max(0, fraction));
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (fill) {
      fill.style.animation = "none";
      fill.style.transform = `scaleY(${progress})`;
    }
    if (currentProgressFill) {
      currentProgressFill.style.animation = "none";
      currentProgressFill.style.transform = `scaleX(${progress})`;
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

  function startProgressAnimation(fill: HTMLElement | null, duration: number): void {
    progressActive = true;
    progressRemainingMs = duration;
    if (fill) {
      fill.style.animation = "none";
      void fill.offsetHeight;
      fill.style.animation = !reduceMotion ? `storyProgressVertical ${duration}ms linear forwards` : "none";
      fill.style.animationPlayState = isPaused() ? "paused" : "running";
    }
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
    if (!post || (!fill && !currentProgressFill)) return;
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
    videoDriven = false;
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
    if (videoDriven) {
      return;
    }
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
    if (!video || !post || post.mediaType !== "video") return;
    clearVideoProgressFallback();
    if (Number.isFinite(video.duration) && video.duration > 0) {
      clearAdvanceTimer();
      videoDriven = true;
      progressActive = true;
      handleVideoTimeUpdate();
      return;
    }
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (fill?.style.animation && fill.style.animation !== "none") {
      fill.style.animationPlayState = isPaused() ? "paused" : "running";
      if (!isPaused() && !advanceTimer) scheduleAdvance(progressRemainingMs);
      return;
    }
    startProgressAnimation(fill, intervalMs);
  }

  function handleVideoTimeUpdate(): void {
    const post = posts[activeIndex()];
    if (!video || !post || post.mediaType !== "video" || !Number.isFinite(video.duration) || video.duration <= 0) return;
    videoDriven = true;
    progressActive = true;
    clearAdvanceTimer();
    setProgress(video.currentTime / video.duration);
  }

  function handleVideoEnded(): void {
    if (!videoDriven || posts[activeIndex()]?.mediaType !== "video") return;
    setProgress(1);
    progressActive = false;
    videoDriven = false;
    onAdvance();
  }

  function handleVideoWaiting(): void {
    if (posts[activeIndex()]?.mediaType !== "video") return;
    pauseAdvanceTimer();
    const fill = progressBars[activeIndex()]?.querySelector<HTMLElement>("i");
    if (fill) fill.style.animationPlayState = "paused";
    if (currentProgressFill) currentProgressFill.style.animationPlayState = "paused";
  }

  return {
    resetForStory,
    update,
    resumeAfterManualNavigation,
    handleVideoPlaying,
    handleVideoTimeUpdate,
    handleVideoEnded,
    handleVideoWaiting,
    debugState: () => ({ progressActive, progressRestartBlocked, advanceTimer }),
  };
}
