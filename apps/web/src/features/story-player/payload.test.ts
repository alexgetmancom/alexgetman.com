import { describe, expect, it } from "bun:test";
import type { HomePost } from "../../components/home-news/types";
import { toPlayerPosts } from "./payload";

function homePost(overrides: Partial<HomePost> = {}): HomePost {
  return {
    id: 1,
    url: "/1/example/",
    title: "Example post",
    body: "A short body.",
    excerpt: "A short body.",
    date: "2026-07-15T10:00:00.000Z",
    relativeDate: "now",
    image: null,
    views: 0,
    categorySlug: "news",
    category: "News",
    ...overrides,
  };
}

describe("toPlayerPosts", () => {
  it("carries media, audio and gallery fields through unchanged", () => {
    const [post] = toPlayerPosts([
      homePost({
        image: "media/posts/1-en-0.jpg",
        fallbackImage: "og/posts/post-1-en.jpg",
        mediaType: "video",
        gallery: [{ type: "image", path: "media/posts/1-en-0.jpg" }],
        audioUrl: "media/posts/1-en-0.mp3",
        spotifyUrl: "https://open.spotify.com/track/x",
        imageSrcSet: "/generated/responsive/x-360.webp 360w",
        posterSrc: "generated/responsive/x-960.webp",
      }),
    ]);

    expect(post.image).toBe("/media/posts/1-en-0.jpg");
    expect(post.fallbackImage).toBe("/og/posts/post-1-en.jpg");
    expect(post.mediaType).toBe("video");
    expect(post.gallery).toEqual([{ type: "image", path: "/media/posts/1-en-0.jpg", poster: null }]);
    expect(post.audioUrl).toBe("media/posts/1-en-0.mp3");
    expect(post.spotifyUrl).toBe("https://open.spotify.com/track/x");
    expect(post.posterSrc).toBe("/generated/responsive/x-960.webp");
  });

  it("marks a short single-paragraph post latest-only", () => {
    const [post] = toPlayerPosts([homePost({ body: "Short." })]);
    expect(post.feedModes).toEqual(["latest"]);
  });

  it("marks a long post deep by character count", () => {
    const [post] = toPlayerPosts([homePost({ body: "x".repeat(700) })]);
    expect(post.feedModes).toEqual(["latest", "deep"]);
  });

  it("marks a multi-paragraph post deep even if short", () => {
    const [post] = toPlayerPosts([homePost({ body: "One\nTwo\nThree\nFour" })]);
    expect(post.feedModes).toEqual(["latest", "deep"]);
  });

  it("marks only the top ~8 posts by views as watched", () => {
    const posts = Array.from({ length: 10 }, (_, index) => homePost({ id: index, views: 10 - index }));
    const players = toPlayerPosts(posts);

    const watched = players.filter((post) => post.feedModes.includes("watched"));
    expect(watched).toHaveLength(8);
    expect(watched.map((post) => post.views)).toEqual(["10", "9", "8", "7", "6", "5", "4", "3"]);
  });

  it("marks nothing watched when every post has zero views", () => {
    const players = toPlayerPosts([homePost({ views: 0 }), homePost({ id: 2, views: 0 })]);
    expect(players.every((post) => !post.feedModes.includes("watched"))).toBe(true);
  });
});
