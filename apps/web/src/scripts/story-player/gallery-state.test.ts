import { describe, expect, it } from "bun:test";
import { advanceGallerySequence } from "./gallery-state.js";

describe("gallery sequence state", () => {
  it("moves to the next slide when more images remain in the post", () => {
    expect(advanceGallerySequence(0, 3)).toEqual({ subIndex: 1, advancePost: false });
    expect(advanceGallerySequence(1, 3)).toEqual({ subIndex: 2, advancePost: false });
  });

  it("advances to the next post once the last slide has been shown", () => {
    expect(advanceGallerySequence(2, 3)).toEqual({ subIndex: 2, advancePost: true });
  });

  it("advances to the next post immediately for single-image or gallery-less posts", () => {
    expect(advanceGallerySequence(0, 1)).toEqual({ subIndex: 0, advancePost: true });
    expect(advanceGallerySequence(0, 0)).toEqual({ subIndex: 0, advancePost: true });
  });
});
