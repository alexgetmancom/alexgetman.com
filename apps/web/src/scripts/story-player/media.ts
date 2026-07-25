import type { StoryPost } from "./types";

/** Broken/missing image → swap to the post's fallback once, then hide the
 * element entirely if even the fallback fails. */
export function onStoryImageError(event: Event, fallbackImage: string | null | undefined): void {
  const img = event.currentTarget as HTMLImageElement;
  if (fallbackImage && img.getAttribute("src") !== fallbackImage) {
    img.setAttribute("src", fallbackImage);
    img.removeAttribute("srcset");
  } else {
    img.style.display = "none";
  }
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
    const src = toPublicSrc(post.posterSrc || post.fallbackImage || post.image);
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
  preloadGallery(posts[active], toPublicSrc);
}

/** Slides 2..N of the *current* post are shown by swapping one <img>'s src, so
 * an unfetched slide leaves the frame blank until it decodes. Only the cover was
 * warmed above; warm the rest of the sequence too. */
function preloadGallery(post: StoryPost | undefined, toPublicSrc: (value: string | undefined) => string): void {
  if (!post?.gallery || post.gallery.length < 2 || post.__galleryPreloaded) return;
  post.__galleryPreloaded = true;
  for (const media of post.gallery) {
    if (media.type === "video") continue;
    const src = toPublicSrc(media.path ?? undefined);
    if (src) new Image().src = src;
  }
}
