import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FeedItem } from "../server/public-site";
import { existingSiteImage, toHomePost } from "./home-posts";

function feedItem(overrides: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "post:1",
    post_id: 1,
    message_id: 1,
    date: "2026-07-15T10:00:00.000Z",
    text: "Русский текст поста",
    text_ru: "Русский текст поста",
    text_en: "English post text",
    html: "",
    html_en: "",
    slug_ru: "russkiy-post",
    slug_en: "english-post",
    has_ru: true,
    has_en: true,
    media: [],
    media_en: [],
    image: null,
    image_en: null,
    sources: [],
    entities: [],
    views: 12,
    ...overrides,
  };
}

/** `existingSiteImage` checks the real filesystem; point SITE_PUBLIC_DIR at a
 * throwaway temp dir (the same seam siteJobs/siteParity/home.smoke tests use)
 * so these tests don't depend on which files happen to live in apps/web/public. */
let siteDir: string;
beforeEach(() => {
  siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "alexgetman-home-posts-"));
  process.env.SITE_PUBLIC_DIR = siteDir;
});
afterEach(() => {
  delete process.env.SITE_PUBLIC_DIR;
  fs.rmSync(siteDir, { recursive: true, force: true });
});

function touch(relativePath: string): void {
  const filePath = path.join(siteDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "fixture");
}

describe("existingSiteImage", () => {
  it("returns null for a falsy path", () => {
    expect(existingSiteImage(null)).toBeNull();
    expect(existingSiteImage(undefined)).toBeNull();
    expect(existingSiteImage("")).toBeNull();
  });

  it("returns null when the file does not exist anywhere", () => {
    expect(existingSiteImage("media/posts/does-not-exist.jpg")).toBeNull();
  });

  it("returns the normalized path once the file exists under SITE_PUBLIC_DIR", () => {
    touch("media/posts/1-en-0.jpg");
    expect(existingSiteImage("media/posts/1-en-0.jpg")).toBe("media/posts/1-en-0.jpg");
    expect(existingSiteImage("/media/posts/1-en-0.jpg")).toBe("media/posts/1-en-0.jpg");
  });
});

describe("toHomePost", () => {
  it("resolves an image post whose file exists", () => {
    touch("media/posts/1-en-0.jpg");
    const post = toHomePost(feedItem({ image_en: "media/posts/1-en-0.jpg" }), "en");

    expect(post.mediaType).toBe("image");
    expect(post.image).toBe("media/posts/1-en-0.jpg");
    expect(post.url).toBe("/1/english-post/");
    expect(post.gallery).toEqual([{ type: "image", path: "media/posts/1-en-0.jpg" }]);
  });

  it("resolves a video post and keeps the poster as the fallback image", () => {
    touch("media/posts/1-en-0.mp4");
    touch("media/posts/1-en-0-poster.jpg");
    const post = toHomePost(
      feedItem({ media_en: [{ type: "video", path: "media/posts/1-en-0.mp4", poster: "media/posts/1-en-0-poster.jpg" }] }),
      "en",
    );

    expect(post.mediaType).toBe("video");
    expect(post.image).toBe("media/posts/1-en-0.mp4");
    expect(post.fallbackImage).toBe("media/posts/1-en-0-poster.jpg");
    expect(post.posterSrc).toContain("1-en-0-poster-960.webp");
  });

  it("falls back to the OG image when no post media file exists on disk", () => {
    touch("og/posts/post-1-en.jpg");
    const post = toHomePost(feedItem({ image_en: "media/posts/1-en-0.jpg" /* not touched: missing on disk */ }), "en");

    expect(post.mediaType).toBe("image");
    expect(post.image).toBe("og/posts/post-1-en.jpg");
  });

  it("has no image at all when neither post media nor the OG image exist", () => {
    const post = toHomePost(feedItem({ image_en: "media/posts/1-en-0.jpg" }), "en");

    expect(post.mediaType).toBeNull();
    expect(post.image).toBeNull();
  });

  it("drops gallery entries whose file is missing on disk", () => {
    touch("media/posts/1-en-0.jpg");
    const post = toHomePost(
      feedItem({
        image_en: "media/posts/1-en-0.jpg",
        media_en: [{ path: "media/posts/1-en-0.jpg" }, { path: "media/posts/1-en-1.jpg" /* not touched */ }],
      }),
      "en",
    );

    expect(post.gallery).toEqual([{ type: "image", path: "media/posts/1-en-0.jpg" }]);
  });

  it("builds the Russian locale url and reads the Russian text", () => {
    const post = toHomePost(feedItem(), "ru");
    expect(post.url).toBe("/ru/1/russkiy-post/");
    expect(post.body).toBe("Русский текст поста");
  });
});
