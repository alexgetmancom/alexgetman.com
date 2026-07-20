/* УСТАРЕЛО: часть старого vanilla-плеера, больше не подключено. Новый плеер:
 * features/story-player/ (см. README). Не развивать; удалить после сверки. */
export {};

declare global {
  interface Window {
    StoryPlayerUtils?: {
      normalizedPath: (value: string) => string;
      applyImageFallback: (image: HTMLImageElement) => boolean;
      isTypingTarget: (element: Element | null) => boolean;
    };
  }
}

(() => {
  function normalizedPath(value: string): string {
    try {
      const url = new URL(value, window.location.origin);
      return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
    } catch {
      return "/";
    }
  }

  function applyImageFallback(img: HTMLImageElement): boolean {
    const fallbackSrc = img.dataset.fallbackSrc;
    if (!fallbackSrc || img.getAttribute("src") === fallbackSrc) {
      img.style.display = "none";
      return false;
    }
    img.setAttribute("src", fallbackSrc);
    img.removeAttribute("srcset");
    return true;
  }

  function isTypingTarget(element: Element | null): boolean {
    const tagName = element?.tagName;
    return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
  }

  window.StoryPlayerUtils = {
    normalizedPath,
    applyImageFallback,
    isTypingTarget,
  };
})();
