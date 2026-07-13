import { createStoryViewTracker } from "./story-player/analytics";
import { storyPlayerBrowserUtils } from "./story-player/browser";
import { renderDebugState } from "./story-player/debug";
import { loadGiscusDiscussion } from "./story-player/discussion";
import { bindStoryPlayerElements, readStoryPayload } from "./story-player/dom";
import { createFeedModeController } from "./story-player/feed-mode";
import { centerRailCard, hydrateRailMedia, preloadAdjacentMedia } from "./story-player/media";
import { createStoryProgressController } from "./story-player/progress";
import { renderStoryFrame, syncReadMore } from "./story-player/render-frame";

(() => {
  const rootCandidate = document.querySelector<HTMLElement>("[data-story-player]");
  if (!rootCandidate) return;
  const root = rootCandidate;

  const payload = readStoryPayload(root);
  const posts = payload.posts || [];
  const ui = payload.ui || {};
  const giscusConfig = payload.giscus || {};
  if (!posts.length) return;

  const { normalizedPath, applyImageFallback, isTypingTarget, toPublicSrc } = storyPlayerBrowserUtils();
  const elements = bindStoryPlayerElements(root);
  const {
    image,
    video,
    cardLink,
    visual,
    title,
    categoryWrap,
    meta,
    copy,
    readMore,
    rail,
    progressBars,
    currentProgressFill,
    railCards,
    feedModeButtons,
    feedModeTrigger,
    feedModeLabel,
    feedModeMenu,
    shareButtons,
    discussButtons,
    discussLabels,
    postPanel,
    discussionPanel,
    discussionFrame,
    audioToggle,
    audioLabel,
    audio,
    playPauseOverlay,
  } = elements;

  let active = 0;
  let isManualPaused = payload.initialPaused === true || root.dataset.initialPaused === "true";
  let isHoverPaused = false;
  let isInteractionPaused = false;
  let paused = isManualPaused;
  let muted = localStorage.getItem("story-player-muted") !== "false";
  let expanded = false;
  let wheelGestureLocked = false;
  let wheelUnlockTimer: number | null = null;
  let interactionPauseTimer: number | null = null;
  let discussionTerm = "";
  let discussionVisible = false;
  const debugPanel = new URLSearchParams(window.location.search).has("debug") ? document.createElement("pre") : null;

  const feedMode = createFeedModeController({ posts, ui, railCards, feedModeButtons, feedModeLabel, activeIndex: () => active });
  const storyViewTracker = createStoryViewTracker({ activeIndex: () => active, normalizedPath });
  const progress = createStoryProgressController({
    root,
    video,
    progressBars,
    currentProgressFill,
    posts,
    activeIndex: () => active,
    isPaused: () => paused,
    onAdvance: () => render(feedMode.nextVisibleStoryIndex(1)),
  });

  function updatePlayState(): void {
    paused = isManualPaused || isHoverPaused || isInteractionPaused;
    progress.update(paused);
    if (video && posts[active]?.mediaType === "video") {
      if (paused) video.pause?.();
      else video.play?.().catch(() => {});
    }
    renderDebugState(debugPanel, { active, posts, paused, isManualPaused, isInteractionPaused, ...progress.debugState() });
  }

  function setDiscussionVisible(isVisible: boolean): void {
    if (!postPanel || !discussionPanel) return;
    const wasDiscussionVisible = discussionVisible;
    discussionVisible = isVisible;
    discussionPanel.hidden = !isVisible;
    root.classList.toggle("is-discussing", isVisible);
    if (categoryWrap) categoryWrap.hidden = isVisible;
    if (meta) meta.hidden = isVisible;
    if (title) title.hidden = isVisible;
    if (copy) copy.hidden = isVisible;
    if (readMore) readMore.hidden = true;
    discussLabels.forEach((label) => {
      label.textContent = isVisible ? ui.backToPost || "Back to post" : ui.discuss || "Discuss";
    });
    if (isVisible) isManualPaused = true;
    else if (wasDiscussionVisible) isManualPaused = false;
    updatePlayState();
  }

  function render(index: number, options: { keepProgressIdle?: boolean } = {}): void {
    active = (index + posts.length) % posts.length;
    const post = posts[active];
    if (!post) return;
    expanded = false;
    setDiscussionVisible(false);
    const panel = root.querySelector(".story-panel");
    panel?.classList.add("is-updating");
    renderStoryFrame({ root, elements, post, muted, paused, expanded, ui, toPublicSrc });
    progress.resetForStory(options);
    railCards.forEach((card, cardIndex) => {
      const isCurrent = cardIndex === active;
      card.classList.toggle("is-active", isCurrent);
      if (isCurrent) window.setTimeout(() => centerRailCard(rail, card), 60);
    });
    updatePlayState();
    feedMode.syncFeedModeControls();
    storyViewTracker.scheduleStoryView(post);
    hydrateRailMedia({ active, posts, railCards, toPublicSrc });
    preloadAdjacentMedia({ active, posts, toPublicSrc });
    if (panel) {
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => panel.classList.remove("is-updating"));
      });
    }
  }

  root.querySelectorAll("img").forEach((img) => {
    img.addEventListener("error", () => {
      if (!applyImageFallback(img)) img.style.display = "none";
    });
    if (img.getAttribute("src") && img.complete && img.naturalWidth === 0 && !applyImageFallback(img)) img.style.display = "none";
  });

  video?.addEventListener("error", () => {
    const fallbackSrc = video.dataset.fallbackSrc;
    if (!fallbackSrc || !image) return;
    video.hidden = true;
    video.pause?.();
    video.removeAttribute("src");
    image.hidden = false;
    image.setAttribute("src", fallbackSrc);
    image.removeAttribute("srcset");
  });
  video?.addEventListener("playing", () => progress.handleVideoPlaying());
  video?.addEventListener("waiting", () => progress.handleVideoWaiting());

  railCards.forEach((card, index) => {
    card.addEventListener("click", (event) => {
      event.preventDefault();
      if (!feedMode.isStoryVisible(index)) return;
      render(index, { keepProgressIdle: true });
      progress.resumeAfterManualNavigation();
    });
  });

  feedModeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const nextMode = button.dataset.feedMode || "latest";
      feedModeMenu?.classList.remove("is-open");
      feedModeTrigger?.setAttribute("aria-expanded", "false");
      if (nextMode === feedMode.mode()) return;
      feedMode.setMode(nextMode);
      feedMode.syncFeedModeControls();
      render(feedMode.isStoryVisible(active) ? active : (feedMode.visibleStoryIndexes()[0] ?? 0), { keepProgressIdle: true });
      progress.resumeAfterManualNavigation();
    });
  });

  feedModeTrigger?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !feedModeMenu?.classList.contains("is-open");
    feedModeMenu?.classList.toggle("is-open", isOpen);
    feedModeTrigger.setAttribute("aria-expanded", String(isOpen));
  });
  document.addEventListener("click", (event) => {
    if (!feedModeMenu || !feedModeTrigger || (event.target instanceof Node && feedModeMenu.contains(event.target))) return;
    feedModeMenu.classList.remove("is-open");
    feedModeTrigger.setAttribute("aria-expanded", "false");
  });

  cardLink?.addEventListener("click", (event) => {
    event.preventDefault();
    isManualPaused = !isManualPaused;
    if (!isManualPaused) isHoverPaused = false;
    const icon = playPauseOverlay.querySelector(".play-pause-icon");
    if (icon) {
      icon.className = `play-pause-icon ${isManualPaused ? "is-paused" : "is-playing"}`;
      playPauseOverlay.classList.remove("is-visible");
      void playPauseOverlay.offsetWidth;
      playPauseOverlay.classList.add("is-visible");
    }
    updatePlayState();
  });

  let lastWheelTime = 0;
  const wheelCooldownMs = 140;
  function navigate(direction: number): void {
    render(feedMode.nextVisibleStoryIndex(direction), { keepProgressIdle: true });
    progress.resumeAfterManualNavigation();
  }
  function handleWheel(event: WheelEvent): void {
    if (Math.abs(event.deltaY) < 10) return;
    event.preventDefault();
    const now = Date.now();
    if (wheelGestureLocked || now - lastWheelTime < wheelCooldownMs) return;
    lastWheelTime = now;
    wheelGestureLocked = true;
    if (wheelUnlockTimer) window.clearTimeout(wheelUnlockTimer);
    wheelUnlockTimer = window.setTimeout(() => {
      wheelGestureLocked = false;
      wheelUnlockTimer = null;
    }, wheelCooldownMs);
    navigate(event.deltaY > 0 ? 1 : -1);
  }
  visual?.addEventListener("wheel", handleWheel, { passive: false });
  root.querySelector<HTMLElement>(".story-rail-container")?.addEventListener("wheel", handleWheel, { passive: false });

  readMore?.addEventListener("click", () => {
    const post = posts[active];
    if (!post) return;
    expanded = !expanded;
    syncReadMore({ copy, readMore, post, expanded, ui });
  });
  discussButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (discussionVisible) return setDiscussionVisible(false);
      const post = posts[active];
      if (!post) return;
      discussionTerm = loadGiscusDiscussion({ post, discussionFrame, giscusConfig, ui, currentTerm: discussionTerm });
      setDiscussionVisible(true);
      if (window.matchMedia("(max-width: 760px)").matches) discussionPanel?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  shareButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      const post = posts[active];
      if (!post) return;
      const url = new URL(post.url, window.location.origin).href;
      try {
        if (navigator.share) await navigator.share({ title: post.title, url });
        else {
          await navigator.clipboard.writeText(url);
          const label = button.querySelector("span");
          if (label) {
            label.textContent = ui.copied || "Copied";
            window.setTimeout(() => (label.textContent = ui.share || "Share"), 1400);
          }
        }
      } catch {
        await navigator.clipboard?.writeText(url).catch(() => {});
      }
    });
  });
  audioToggle?.addEventListener("click", () => {
    muted = !muted;
    localStorage.setItem("story-player-muted", String(muted));
    audioToggle.setAttribute("aria-pressed", String(muted));
    audioToggle.classList.toggle("is-on", !muted);
    if (audioLabel) audioLabel.textContent = muted ? ui.muted || "Muted" : ui.mute || "Audio";
    if (audio) {
      audio.muted = muted;
      if (!muted && audio.getAttribute("src") && posts[active]?.mediaType !== "video") audio.play?.().catch(() => {});
      else audio.pause?.();
    }
    if (video) video.muted = muted;
  });

  let startX = 0;
  root.addEventListener("touchstart", (event) => (startX = event.touches[0]?.clientX || 0), { passive: true });
  root.addEventListener(
    "touchend",
    (event) => {
      const delta = (event.changedTouches[0]?.clientX || 0) - startX;
      if (Math.abs(delta) > 55) navigate(delta < 0 ? 1 : -1);
    },
    { passive: true },
  );
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || isTypingTarget(document.activeElement)) return;
    if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      navigate(1);
    } else if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      navigate(-1);
    } else if (event.key === " ") {
      event.preventDefault();
      isManualPaused = !isManualPaused;
      isInteractionPaused = false;
      if (interactionPauseTimer) window.clearTimeout(interactionPauseTimer);
      interactionPauseTimer = null;
      updatePlayState();
    }
  });

  audioToggle?.setAttribute("aria-pressed", String(muted));
  audioToggle?.classList.toggle("is-on", !muted);
  if (audioLabel) audioLabel.textContent = muted ? ui.muted || "Muted" : ui.mute || "Audio";
  feedMode.syncFeedModeControls();
  if (debugPanel) {
    debugPanel.className = "story-debug-panel";
    root.appendChild(debugPanel);
  }
  render(0);
})();
