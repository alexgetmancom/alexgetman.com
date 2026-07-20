/* УСТАРЕЛО: часть старого vanilla-плеера, больше не подключено. Новый плеер:
 * features/story-player/ (см. README). Не развивать; удалить после сверки. */
import type { StoryPost } from "./types";

type FeedModeControllerOptions = {
  posts: StoryPost[];
  ui: Record<string, string>;
  railCards: HTMLElement[];
  feedModeButtons: HTMLButtonElement[];
  feedModeLabel: HTMLElement | null;
  activeIndex: () => number;
};

export function createFeedModeController({
  posts,
  ui,
  railCards,
  feedModeButtons,
  feedModeLabel,
  activeIndex,
}: FeedModeControllerOptions): {
  mode: () => string;
  setMode: (value: string) => void;
  visibleStoryIndexes: () => number[];
  isStoryVisible: (index: number) => boolean;
  nextVisibleStoryIndex: (direction: number) => number;
  syncFeedModeControls: () => void;
} {
  let activeFeedMode = "latest";

  function visibleStoryIndexes(): number[] {
    const visible = posts
      .map((post, index) => ({ post, index }))
      .filter(({ post }) => activeFeedMode === "latest" || post.feedModes?.includes(activeFeedMode))
      .map(({ index }) => index);
    return visible.length ? visible : posts.map((_, index) => index);
  }

  function isStoryVisible(index: number): boolean {
    return visibleStoryIndexes().includes(index);
  }

  function nextVisibleStoryIndex(direction: number): number {
    const visible = visibleStoryIndexes();
    const currentPosition = visible.indexOf(activeIndex());
    if (currentPosition === -1) return visible[0] ?? activeIndex();
    return visible[(currentPosition + direction + visible.length) % visible.length] ?? activeIndex();
  }

  function syncFeedModeControls(): void {
    let activeLabel = ui.feedLatest || "Latest";
    feedModeButtons.forEach((button) => {
      const isActive = button.dataset.feedMode === activeFeedMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
      if (isActive) activeLabel = button.textContent?.trim() || activeLabel;
    });
    if (feedModeLabel) feedModeLabel.textContent = activeLabel;
    const visible = new Set(visibleStoryIndexes());
    railCards.forEach((card, index) => {
      card.classList.toggle("is-filtered-out", !visible.has(index));
    });
  }

  return {
    mode: () => activeFeedMode,
    setMode(value: string): void {
      activeFeedMode = value || "latest";
    },
    visibleStoryIndexes,
    isStoryVisible,
    nextVisibleStoryIndex,
    syncFeedModeControls,
  };
}
