import type { StoryPost } from "./types";

type StoryViewOptions = {
  activeIndex: () => number;
  normalizedPath: (value: string) => string;
};

export function createStoryViewTracker({ activeIndex, normalizedPath }: StoryViewOptions): {
  scheduleStoryView: (post: StoryPost) => void;
} {
  let storyViewTimer: number | null = null;

  function recordStoryView(post: StoryPost): void {
    if (!post?.url) return;
    if (window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1")) return;
    const path = normalizedPath(post.url);
    if (normalizedPath(window.location.pathname) === path) return;
    const key = `story-view:${path}`;
    try {
      if (window.sessionStorage.getItem(key)) return;
      window.sessionStorage.setItem(key, "1");
    } catch {}

    const payload = JSON.stringify({ path, source: "home_story", post_id: post.id });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/stats/pageview", new Blob([payload], { type: "application/json" }));
        return;
      }
      fetch("/stats/pageview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
        keepalive: true,
        credentials: "omit",
        cache: "no-store",
      });
    } catch {}
  }

  return {
    scheduleStoryView(post: StoryPost): void {
      if (storyViewTimer) window.clearTimeout(storyViewTimer);
      const scheduledIndex = activeIndex();
      storyViewTimer = window.setTimeout(() => {
        if (scheduledIndex === activeIndex()) {
          recordStoryView(post);
        }
      }, 2000);
    },
  };
}
