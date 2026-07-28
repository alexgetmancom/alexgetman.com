import { describe, expect, it } from "bun:test";
import { readSwipe, readTapIntent } from "./gestures";

const THRESHOLD = 55;
const EDGE = 0.28;

describe("readSwipe", () => {
  it("moves forward when the finger goes up", () => {
    expect(readSwipe(0, -80, THRESHOLD)).toBe("next");
  });

  it("moves back when the finger goes down", () => {
    expect(readSwipe(0, 80, THRESHOLD)).toBe("previous");
  });

  it("ignores a drag that never clears the threshold", () => {
    expect(readSwipe(0, -54, THRESHOLD)).toBe("none");
  });

  /* The regression this function exists for: reading text scrolls vertically
     with sideways drift, and a handler watching only X changed the post. */
  it("ignores a horizontal drag no matter how long", () => {
    expect(readSwipe(400, 0, THRESHOLD)).toBe("none");
  });

  it("ignores a diagonal drag that leans horizontal", () => {
    expect(readSwipe(120, -90, THRESHOLD)).toBe("none");
  });

  it("accepts a diagonal drag that leans vertical", () => {
    expect(readSwipe(60, -90, THRESHOLD)).toBe("next");
  });
});

describe("readTapIntent", () => {
  it("reads the left band as the previous image", () => {
    expect(readTapIntent(0.1, true, EDGE)).toBe("previous-image");
  });

  it("reads the right band as the next image", () => {
    expect(readTapIntent(0.9, true, EDGE)).toBe("next-image");
  });

  it("reads the middle as play/pause", () => {
    expect(readTapIntent(0.5, true, EDGE)).toBe("toggle-play");
  });

  /* Without a gallery there is nothing to page through, so the edges must not
     become dead zones — the whole frame stays a play/pause target. */
  it("keeps the whole frame tappable when the post has one image", () => {
    expect(readTapIntent(0.02, false, EDGE)).toBe("toggle-play");
    expect(readTapIntent(0.98, false, EDGE)).toBe("toggle-play");
  });
});
