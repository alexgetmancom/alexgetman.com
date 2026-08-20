import { sendPageview } from "../pageview";
import type { StoryPost } from "./types";

type StoryViewOptions = {
  activeIndex: () => number;
  normalizedPath: (value: string) => string;
  /** How long a story must stay on screen before it counts as viewed. Exposed so
   * tests can exercise the dwell rule without sleeping for the real delay. */
  dwellMs?: number;
};

export function createStoryViewTracker({ activeIndex, normalizedPath, dwellMs = 2000 }: StoryViewOptions): {
  scheduleStoryView: (post: StoryPost) => void;
} {
  let storyViewTimer: number | null = null;

  function recordStoryView(post: StoryPost): void {
    if (!post?.url) return;
    const path = normalizedPath(post.url);
    if (normalizedPath(window.location.pathname) === path) return;
    const key = `story-view:${path}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {}

    sendPageview({ path, source: "home_story", post_id: post.id });
  }

  return {
    scheduleStoryView(post: StoryPost): void {
      if (storyViewTimer) window.clearTimeout(storyViewTimer);
      const scheduledIndex = activeIndex();
      storyViewTimer = window.setTimeout(() => {
        if (scheduledIndex === activeIndex()) {
          recordStoryView(post);
        }
      }, dwellMs);
    },
  };
}
