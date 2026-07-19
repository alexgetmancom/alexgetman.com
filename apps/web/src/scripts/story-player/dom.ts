import type { StoryPayload, StoryPlayerElements } from "./types";

export function readStoryPayload(root: HTMLElement): StoryPayload {
  const payloadEl = root.querySelector<HTMLElement>("[data-story-payload]");
  return (payloadEl ? JSON.parse(payloadEl.textContent || "{}") : {}) as StoryPayload;
}

export function bindStoryPlayerElements(root: HTMLElement): StoryPlayerElements {
  const discussButtons = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-story-discuss]"));
  const playPauseOverlay = document.createElement("div");
  playPauseOverlay.className = "play-pause-overlay";
  playPauseOverlay.innerHTML = '<div class="play-pause-icon"></div>';

  const visual = root.querySelector<HTMLElement>("[data-story-visual]");
  if (visual) {
    visual.appendChild(playPauseOverlay);
  }

  return {
    image: root.querySelector<HTMLImageElement>("[data-story-image]"),
    video: root.querySelector<HTMLVideoElement>("[data-story-video]"),
    fallback: root.querySelector<HTMLElement>("[data-story-fallback]"),
    cardLink: root.querySelector<HTMLAnchorElement>("[data-story-card-link]"),
    visual,
    gallery: root.querySelector<HTMLElement>("[data-story-gallery]"),
    title: root.querySelector<HTMLElement>("[data-story-title]"),
    categoryWrap: root.querySelector<HTMLElement>(".story-category-wrap"),
    meta: root.querySelector<HTMLElement>(".story-meta"),
    kicker: root.querySelector<HTMLElement>("[data-story-kicker]"),
    mobileKicker: root.querySelector<HTMLElement>("[data-story-mobile-kicker]"),
    mobileTitle: root.querySelector<HTMLElement>("[data-story-mobile-title]"),
    time: root.querySelector<HTMLElement>("[data-story-time]"),
    views: root.querySelector<HTMLElement>("[data-story-views]"),
    copy: root.querySelector<HTMLElement>("[data-story-copy]"),
    readMore: root.querySelector<HTMLButtonElement>("[data-story-read-more]"),
    rail: root.querySelector<HTMLElement>(".story-rail"),
    currentProgressFill: root.querySelector<HTMLElement>("[data-story-current-progress]"),
    railCards: Array.from(root.querySelectorAll<HTMLElement>("[data-story-index]")),
    feedModeButtons: Array.from(root.querySelectorAll<HTMLButtonElement>("[data-feed-mode]")),
    feedModeTrigger: root.querySelector<HTMLButtonElement>("[data-feed-mode-trigger]"),
    feedModeLabel: root.querySelector<HTMLElement>("[data-feed-mode-label]"),
    feedModeMenu: root.querySelector<HTMLElement>(".feed-mode-menu"),
    shareButtons: Array.from(root.querySelectorAll<HTMLButtonElement>("[data-story-share]")),
    discussButtons,
    readButtons: Array.from(root.querySelectorAll<HTMLButtonElement>("[data-story-read]")),
    discussLabels: discussButtons.map((button) => button.querySelector("span")).filter((label): label is HTMLSpanElement => label != null),
    context: root.querySelector<HTMLElement>("[data-story-context]"),
    postPanel: root.querySelector<HTMLElement>('[data-panel="post"]'),
    discussionPanel: root.querySelector<HTMLElement>('[data-panel="discussion"]'),
    discussionFrame: root.querySelector<HTMLElement>("[data-story-discussion-frame]"),
    audioToggle: root.querySelector<HTMLButtonElement>("[data-audio-toggle]"),
    audioLabel: root.querySelector<HTMLElement>("[data-audio-label]"),
    audio: root.querySelector<HTMLAudioElement>("[data-story-audio]"),
    playPauseOverlay,
  };
}
