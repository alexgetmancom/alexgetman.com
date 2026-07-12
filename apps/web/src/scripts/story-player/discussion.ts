import type { StoryPost } from "./types";

export function loadGiscusDiscussion(options: {
  post: StoryPost;
  discussionFrame: HTMLElement | null;
  giscusConfig: Record<string, string>;
  ui: Record<string, string>;
  currentTerm: string;
}): string {
  const { post, discussionFrame, giscusConfig, ui, currentTerm } = options;
  if (!discussionFrame || !post?.url) return currentTerm;
  const url = new URL(post.url, window.location.origin).href;
  if (currentTerm === url) return currentTerm;
  discussionFrame.innerHTML = "";
  const loading = document.createElement("div");
  loading.className = "story-discussion-loading";
  loading.textContent = ui.discussionTab || "Discussion";
  discussionFrame.appendChild(loading);
  const script = document.createElement("script");
  script.src = "https://giscus.app/client.js";
  script.async = true;
  script.crossOrigin = "anonymous";
  script.setAttribute("data-repo", giscusConfig.repo || "alexgetmancom/alexgetman.com");
  script.setAttribute("data-repo-id", giscusConfig.repoId || "R_kgDOSJwPnQ");
  script.setAttribute("data-category", giscusConfig.category || "Announcements");
  script.setAttribute("data-category-id", giscusConfig.categoryId || "DIC_kwDOSJwPnc4C-S2f");
  script.setAttribute("data-mapping", "specific");
  script.setAttribute("data-term", url);
  script.setAttribute("data-strict", "1");
  script.setAttribute("data-reactions-enabled", "1");
  script.setAttribute("data-emit-metadata", "0");
  script.setAttribute("data-input-position", "bottom");
  script.setAttribute("data-theme", document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  script.setAttribute("data-lang", giscusConfig.lang || document.documentElement.lang || "en");
  discussionFrame.appendChild(script);
  return url;
}
