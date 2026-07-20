/* УСТАРЕЛО: часть старого vanilla-плеера, больше не подключено. Новый плеер:
 * features/story-player/ (см. README). Не развивать; удалить после сверки. */
type StoryPlayerBrowserUtils = {
  normalizedPath: (value: string) => string;
  applyImageFallback: (image: HTMLImageElement) => boolean;
  isTypingTarget: (element: Element | null) => boolean;
  toPublicSrc: (value: string | undefined) => string;
};

export function storyPlayerBrowserUtils(): StoryPlayerBrowserUtils {
  const normalizedPath =
    window.StoryPlayerUtils?.normalizedPath ??
    ((value: string) => {
      try {
        const url = new URL(value, window.location.origin);
        return url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
      } catch {
        return "/";
      }
    });
  const applyImageFallback =
    window.StoryPlayerUtils?.applyImageFallback ??
    ((img: HTMLImageElement) => {
      const fallbackSrc = img.dataset.fallbackSrc;
      if (!fallbackSrc || img.getAttribute("src") === fallbackSrc) {
        img.style.display = "none";
        return false;
      }
      img.setAttribute("src", fallbackSrc);
      img.removeAttribute("srcset");
      return true;
    });
  const isTypingTarget =
    window.StoryPlayerUtils?.isTypingTarget ??
    ((element: Element | null) => {
      const tagName = element?.tagName;
      return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
    });
  const toPublicSrc = (value: string | undefined): string => {
    if (!value) return "";
    const src = String(value);
    if (/^(https?:|data:|blob:|\/)/i.test(src)) return src;
    return `/${src.replace(/^\/+/, "")}`;
  };

  return { normalizedPath, applyImageFallback, isTypingTarget, toPublicSrc };
}
