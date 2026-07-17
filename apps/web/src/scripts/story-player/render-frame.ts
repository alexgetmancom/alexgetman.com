import type { StoryPlayerElements, StoryPost } from "./types";

export function syncReadMore(options: {
  copy: HTMLElement | null;
  readMore: HTMLButtonElement | null;
  post: StoryPost;
  expanded: boolean;
  ui: Record<string, string>;
}): void {
  const { copy, readMore, post, expanded, ui } = options;
  if (!copy || !readMore) return;
  copy.classList.toggle("is-expanded", expanded);
  readMore.textContent = expanded ? post.collapse || ui.collapse || "Collapse" : post.readMore || ui.readMore || "Read more";
  window.requestAnimationFrame(() => {
    const needsMore = copy.scrollHeight > copy.clientHeight + 4 || expanded;
    readMore.hidden = !needsMore;
  });
}

export function renderStoryFrame(options: {
  root: HTMLElement;
  elements: StoryPlayerElements;
  post: StoryPost;
  muted: boolean;
  paused: boolean;
  expanded: boolean;
  ui: Record<string, string>;
  toPublicSrc: (value: string | undefined) => string;
}): void {
  const { root, elements, post, muted, paused, expanded, ui, toPublicSrc } = options;
  const {
    image,
    ambient,
    video,
    fallback,
    cardLink,
    visual,
    gallery,
    kicker,
    mobileKicker,
    mobileTitle,
    time,
    title,
    copy,
    readMore,
    views,
    audio,
  } = elements;

  if (cardLink) cardLink.href = post.url;
  if (visual) visual.classList.toggle("story-visual--no-image", !post.image);
  if (image) {
    image.hidden = !post.image || post.mediaType === "video";
    image.style.removeProperty("display");
    if (post.fallbackImage) image.dataset.fallbackSrc = toPublicSrc(post.fallbackImage);
    else delete image.dataset.fallbackSrc;
    if (post.image && post.mediaType !== "video") {
      image.setAttribute("src", toPublicSrc(post.image));
      if (post.imageSrcSet) image.setAttribute("srcset", post.imageSrcSet);
      else image.removeAttribute("srcset");
    } else {
      image.removeAttribute("src");
      image.removeAttribute("srcset");
    }
  }
  if (ambient) {
    const ambientSrc = post.fallbackImage || (post.mediaType !== "video" ? post.image : undefined);
    if (ambientSrc) {
      const resolved = toPublicSrc(ambientSrc);
      if (ambient.getAttribute("src") !== resolved) ambient.setAttribute("src", resolved);
      ambient.style.opacity = "";
    } else {
      ambient.removeAttribute("src");
      ambient.style.opacity = "0";
    }
  }
  if (video) {
    video.hidden = !post.image || post.mediaType !== "video";
    if (post.fallbackImage) video.dataset.fallbackSrc = toPublicSrc(post.fallbackImage);
    else delete video.dataset.fallbackSrc;
    if (post.image && post.mediaType === "video") {
      if (post.fallbackImage) video.setAttribute("poster", toPublicSrc(post.fallbackImage));
      else video.removeAttribute("poster");
      const videoSrc = toPublicSrc(post.image);
      if (video.getAttribute("src") !== videoSrc) {
        video.setAttribute("src", videoSrc);
        video.load();
      }
      video.muted = muted;
      if (!paused) {
        video.play?.().catch(() => {});
      }
    } else {
      video.pause?.();
      video.removeAttribute("src");
      video.load?.();
    }
  }
  if (fallback) {
    fallback.hidden = !!post.image;
    fallback.textContent = post.title;
  }
  if (gallery) {
    const media = post.gallery || [];
    gallery.hidden = media.length < 2;
    gallery.textContent = "";
    media.forEach((entry, index) => {
      const link = document.createElement("a");
      link.href = toPublicSrc(entry.path);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const thumbnail = document.createElement("img");
      thumbnail.src = toPublicSrc(entry.type === "video" ? entry.poster || entry.path : entry.path);
      thumbnail.alt = `${post.title} — ${index + 1}`;
      thumbnail.loading = "lazy";
      link.appendChild(thumbnail);
      gallery.appendChild(link);
    });
  }
  if (kicker) kicker.textContent = post.category;
  if (mobileKicker) mobileKicker.textContent = post.category;
  if (mobileTitle) mobileTitle.textContent = post.title;
  if (time) time.textContent = post.relativeDate;
  if (title) title.textContent = post.title;
  if (copy) {
    copy.textContent = "";
    copy.classList.remove("is-expanded");
    const paragraphs = Array.isArray(post.body) ? post.body : typeof post.body === "string" ? [post.body] : [post.excerpt];
    paragraphs
      .filter((paragraph): paragraph is string => Boolean(paragraph))
      .forEach((paragraph) => {
        const p = document.createElement("p");
        p.textContent = paragraph;
        copy.appendChild(p);
      });
  }
  syncReadMore({ copy, readMore, post, expanded, ui });
  if (views) views.textContent = post.views || "0";
  if (audio) {
    audio.pause?.();
    if (post.audioUrl && post.mediaType !== "video") {
      if (audio.getAttribute("src") !== post.audioUrl) {
        audio.setAttribute("src", post.audioUrl);
        audio.load?.();
      }
      audio.muted = muted;
      if (!muted && !paused) {
        audio.play?.().catch(() => {});
      }
    } else {
      audio.removeAttribute("src");
      audio.load?.();
    }
  }

  const readingTime = root.querySelector("[data-story-reading-time]");
  if (readingTime) {
    const bodyText = Array.isArray(post.body) ? post.body.join(" ") : post.body || post.excerpt || "";
    const words = bodyText.split(/\s+/).length;
    const mins = Math.max(1, Math.ceil(words / 180));
    readingTime.textContent = `⏱️ ${mins} min`;
  }
}
