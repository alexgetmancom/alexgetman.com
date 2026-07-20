/* УСТАРЕЛО: часть старого vanilla-плеера, больше не подключено. Новый плеер:
 * features/story-player/ (см. README). Не развивать; удалить после сверки. */
import { createStoryViewTracker } from "./story-player/analytics";
import {
  applyMutePreference,
  autoplayRejected,
  beginAutoplay,
  clearAutoplayMute,
  confirmFirstFrame,
  initialVideoAudioState,
  resetForNewStory,
} from "./story-player/audio-state";
import { storyPlayerBrowserUtils } from "./story-player/browser";
import { renderDebugState } from "./story-player/debug";
import { loadGiscusDiscussion } from "./story-player/discussion";
import { setDiscussionVisibility } from "./story-player/discussion-state";
import { bindStoryPlayerElements, readStoryPayload } from "./story-player/dom";
import { createFeedModeController } from "./story-player/feed-mode";
import { centerRailCard, hydrateRailMedia, preloadAdjacentMedia } from "./story-player/media";
import { readMutedPreference } from "./story-player/preferences";
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
    currentProgressFill,
    railCards,
    feedModeButtons,
    feedModeTrigger,
    feedModeLabel,
    feedModeMenu,
    shareButtons,
    discussButtons,
    readButtons,
    discussLabels,
    context,
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
  let paused = isManualPaused;
  let audioState = initialVideoAudioState(readMutedPreference());
  let expanded = false;
  let wheelGestureLocked = false;
  let wheelUnlockTimer: number | null = null;
  let discussionTerm = "";
  let discussionVisible = false;
  let manualPausedBeforeDiscussion = isManualPaused;
  let readingVisible = false;
  let manualPausedBeforeReading = isManualPaused;
  const isDesktopViewport = () => window.matchMedia("(min-width: 761px)").matches;
  const opensDiscussionFromUrl = new URLSearchParams(window.location.search).get("discussion") === "1";
  const debugPanel = new URLSearchParams(window.location.search).has("debug") ? document.createElement("pre") : null;

  const feedMode = createFeedModeController({ posts, ui, railCards, feedModeButtons, feedModeLabel, activeIndex: () => active });
  const storyViewTracker = createStoryViewTracker({ activeIndex: () => active, normalizedPath });
  const progress = createStoryProgressController({
    video,
    currentProgressFill,
    posts,
    activeIndex: () => active,
    isPaused: () => paused,
    onAdvance: () => render(feedMode.nextVisibleStoryIndex(1)),
  });

  function syncMutedUi(): void {
    audioToggle?.setAttribute("aria-pressed", String(audioState.muted));
    audioToggle?.classList.toggle("is-on", !audioState.muted && !audioState.videoAutoplayMuted);
    if (audioLabel) {
      audioLabel.textContent = audioState.videoAutoplayMuted
        ? ui.tapForSound || "Tap for sound"
        : audioState.muted
          ? ui.muted || "Muted"
          : ui.mute || "Audio";
    }
  }

  function setMuted(nextMuted: boolean, persist = true): void {
    audioState = applyMutePreference(nextMuted);
    if (persist) {
      try {
        localStorage.setItem("story-player-muted", String(audioState.muted));
      } catch {}
    }
    syncMutedUi();
    if (audio) {
      audio.muted = audioState.muted;
      if (!audioState.muted && audio.getAttribute("src") && posts[active]?.mediaType !== "video") audio.play?.().catch(() => {});
      else audio.pause?.();
    }
    if (video) video.muted = audioState.muted;
  }

  function playActiveVideo(): void {
    if (!video || posts[active]?.mediaType !== "video") return;
    const play = () => {
      // Chromium permits the automatic start only while muted. Once that
      // succeeds, restore the sound preference the user explicitly chose.
      // Mobile browsers already preserve this path, so keep their behavior
      // untouched.
      const intent = beginAutoplay(audioState, isDesktopViewport());
      audioState = intent.state;
      if (intent.muteBeforePlay) video.muted = true;
      const mutedBeforePlay = video.muted;
      video.play?.().catch(() => {
        // Automatic navigation is not a user gesture. Retry muted when the
        // browser rejects playback with the persisted sound preference.
        const rejection = autoplayRejected(audioState, mutedBeforePlay);
        audioState = rejection.state;
        if (rejection.retryMuted) {
          video.muted = true;
          syncMutedUi();
          video.play?.().catch(() => {});
        } else if (audioState.videoAutoplayMuted) {
          syncMutedUi();
        }
      });
    };
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) video.addEventListener("canplay", play, { once: true });
    else play();
  }

  function updatePlayState(): void {
    paused = isManualPaused;
    progress.update(paused);
    if (video && posts[active]?.mediaType === "video") {
      if (paused) video.pause?.();
      else playActiveVideo();
    }
    renderDebugState(debugPanel, { active, posts, paused, isManualPaused, ...progress.debugState() });
  }

  function setDiscussionVisible(isVisible: boolean): void {
    if (!postPanel || !discussionPanel) return;
    const nextState = setDiscussionVisibility({ visible: discussionVisible, isManualPaused, manualPausedBeforeDiscussion }, isVisible);
    discussionVisible = nextState.visible;
    isManualPaused = nextState.isManualPaused;
    manualPausedBeforeDiscussion = nextState.manualPausedBeforeDiscussion;
    discussionPanel.hidden = !isVisible;
    root.classList.toggle("is-discussing", isVisible);
    if (context) context.setAttribute("aria-hidden", String(!isVisible && !readingVisible));
    if (categoryWrap) categoryWrap.hidden = isVisible;
    if (meta) meta.hidden = isVisible;
    if (title) title.hidden = isVisible;
    if (copy) copy.hidden = isVisible;
    if (readMore) readMore.hidden = true;
    discussLabels.forEach((label) => {
      label.textContent = isVisible ? ui.backToPost || "Back to post" : ui.discuss || "Discuss";
    });
    updatePlayState();
  }

  function setReadingVisible(isVisible: boolean): void {
    if (!context) return;
    readingVisible = isVisible;
    root.classList.toggle("is-reading", isVisible);
    context.setAttribute("aria-hidden", String(!isVisible && !discussionVisible));
    readButtons.forEach((button) => {
      button.setAttribute("aria-expanded", String(isVisible));
      button.classList.toggle("is-open", isVisible);
      const label = button.querySelector("span");
      if (label) label.textContent = isVisible ? ui.back || "Back" : ui.read || "Read";
    });
    if (isVisible) {
      manualPausedBeforeReading = isManualPaused;
      isManualPaused = true;
    } else {
      isManualPaused = manualPausedBeforeReading;
    }
    updatePlayState();
  }

  function render(index: number, options: { keepProgressIdle?: boolean } = {}): void {
    active = (index + posts.length) % posts.length;
    const post = posts[active];
    if (!post) return;
    expanded = false;
    audioState = resetForNewStory(audioState);
    if (readingVisible) setReadingVisible(false);
    setDiscussionVisible(false);
    const panel = root.querySelector(".story-panel");
    panel?.classList.add("is-updating");
    renderStoryFrame({ root, elements, post, muted: audioState.muted, paused, expanded, ui, toPublicSrc });
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
  video?.addEventListener("timeupdate", () => {
    progress.handleVideoTimeUpdate();
    // `timeupdate` proves that at least one real frame has played. Restoring
    // sound here avoids Chrome interrupting a source while it is still
    // entering autoplay, which previously froze both media and progress.
    const confirmation = confirmFirstFrame(audioState, { isManualPaused, isDesktopViewport: isDesktopViewport() });
    audioState = confirmation.state;
    if (!confirmation.shouldRestoreSound) return;
    window.requestAnimationFrame(() => {
      if (!video || audioState.muted || isManualPaused || posts[active]?.mediaType !== "video") return;
      video.muted = false;
      audioState = clearAutoplayMute(audioState);
      syncMutedUi();
    });
  });
  video?.addEventListener("ended", () => progress.handleVideoEnded());
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
  readButtons.forEach((button) => {
    button.addEventListener("click", () => setReadingVisible(!readingVisible));
  });
  discussButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (discussionVisible) return setDiscussionVisible(false);
      const post = posts[active];
      if (!post) return;
      const discussionUrl = new URL(post.url, window.location.origin);
      discussionUrl.searchParams.set("discussion", "1");
      window.history.replaceState(window.history.state, "", `${discussionUrl.pathname}${discussionUrl.search}${discussionUrl.hash}`);
      discussionTerm = loadGiscusDiscussion({ post, discussionFrame, giscusConfig, ui, currentTerm: discussionTerm });
      setDiscussionVisible(true);
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
    if (audioState.videoAutoplayMuted && video) {
      audioState = clearAutoplayMute(audioState);
      video.muted = false;
      syncMutedUi();
      video.play?.().catch(() => {});
      return;
    }
    setMuted(!audioState.muted);
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
    if (event.key === "Escape" && readingVisible) {
      event.preventDefault();
      setReadingVisible(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "PageDown") {
      event.preventDefault();
      navigate(1);
    } else if (event.key === "ArrowUp" || event.key === "PageUp") {
      event.preventDefault();
      navigate(-1);
    } else if (event.key === " ") {
      event.preventDefault();
      isManualPaused = !isManualPaused;
      updatePlayState();
    }
  });

  syncMutedUi();
  feedMode.syncFeedModeControls();
  if (debugPanel) {
    debugPanel.className = "story-debug-panel";
    root.appendChild(debugPanel);
  }
  render(0);
  if (opensDiscussionFromUrl) {
    window.setTimeout(() => {
      const post = posts[active];
      if (!post) return;
      discussionTerm = loadGiscusDiscussion({ post, discussionFrame, giscusConfig, ui, currentTerm: discussionTerm });
      setDiscussionVisible(true);
    }, 0);
  }
})();
