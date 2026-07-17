import type { StoryPost } from "./types";

export function hydrateRailMedia(options: {
  active: number;
  posts: StoryPost[];
  railCards: HTMLElement[];
  toPublicSrc: (value: string | undefined) => string;
}): void {
  const { active, posts, railCards, toPublicSrc } = options;
  railCards.forEach((card, index) => {
    const distance = Math.min(Math.abs(index - active), posts.length - Math.abs(index - active));
    if (distance > 5 || card.dataset.mediaHydrated === "true") return;
    const media = card.querySelector(".rail-card__media");
    const src = card.dataset.mediaSrc;
    if (!media || !src) return;
    const type = card.dataset.mediaType;
    const fallbackSrc = card.dataset.mediaFallback;
    const srcset = card.dataset.mediaSrcset;
    media.innerHTML = "";
    if (type === "video" && !fallbackSrc) {
      const thumbVideo = document.createElement("video");
      thumbVideo.src = `${toPublicSrc(src)}#t=0.001`;
      thumbVideo.muted = true;
      thumbVideo.playsInline = true;
      thumbVideo.preload = "metadata";
      media.appendChild(thumbVideo);
    } else {
      const img = document.createElement("img");
      img.src = toPublicSrc(fallbackSrc || src);
      if (srcset && type !== "video") img.srcset = srcset;
      img.alt = "";
      img.loading = "lazy";
      img.decoding = "async";
      img.sizes = "(max-width: 760px) 38vw, 140px";
      media.appendChild(img);
    }
    card.dataset.mediaHydrated = "true";
  });
}

/** Lays the rail cards out as a 3D drum: the active story sits in the middle,
 * neighbours tilt away into depth and far cards fade out entirely. */
export function layoutDrum(options: {
  rail: HTMLElement | null;
  railCards: HTMLElement[];
  visibleIndexes: number[];
  active: number;
}): void {
  const { rail, railCards, visibleIndexes, active } = options;
  if (!rail || railCards.length === 0) return;
  const order = visibleIndexes.length ? visibleIndexes : railCards.map((_, index) => index);
  const activePosition = Math.max(0, order.indexOf(active));
  const step = Math.min(148, Math.max(92, rail.clientHeight / 5.4));
  railCards.forEach((card, index) => {
    const position = order.indexOf(index);
    if (position === -1) return;
    const offset = position - activePosition;
    const clamped = Math.max(-4, Math.min(4, offset));
    const shown = Math.abs(offset) <= 3;
    card.style.transform = `translate(-50%, -50%) translateY(${(clamped * step).toFixed(1)}px) rotateX(${clamped * -14}deg) translateZ(${Math.abs(clamped) * -48}px)`;
    card.style.opacity = shown ? String(1 - Math.abs(clamped) * 0.2) : "0";
    card.style.zIndex = String(10 - Math.abs(clamped));
    card.style.pointerEvents = shown ? "auto" : "none";
  });
}

export function preloadAdjacentMedia(options: {
  active: number;
  posts: StoryPost[];
  toPublicSrc: (value: string | undefined) => string;
}): void {
  const { active, posts, toPublicSrc } = options;
  [-1, 1, 2].forEach((offset) => {
    const post = posts[(active + offset + posts.length) % posts.length];
    if (!post?.image) return;
    const src = toPublicSrc(post.fallbackImage || post.image);
    if (!src || post.__preloaded) return;
    post.__preloaded = true;
    if (post.mediaType === "video") {
      const preloadVideo = document.createElement("video");
      preloadVideo.src = src;
      preloadVideo.preload = "metadata";
    } else {
      const preloadImage = new Image();
      preloadImage.src = src;
      if (post.imageSrcSet) preloadImage.srcset = post.imageSrcSet;
    }
  });
}
