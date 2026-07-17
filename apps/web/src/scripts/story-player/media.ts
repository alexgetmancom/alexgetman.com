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

export function centerRailCard(rail: HTMLElement | null, card: HTMLElement): void {
  if (!rail || !card) return;
  const left = card.offsetLeft - (rail.clientWidth - card.offsetWidth) / 2;
  const top = card.offsetTop - (rail.clientHeight - card.offsetHeight) / 2;
  rail.scrollTo({
    left: Math.max(0, left),
    top: Math.max(0, top),
    behavior: "smooth",
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
