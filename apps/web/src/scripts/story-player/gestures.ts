/* =============================================================================
 * GESTURE INTENT
 * -----------------------------------------------------------------------------
 * Turning a raw touch or click into "what did the reader mean" is arithmetic,
 * not DOM work, so it lives here where it can be tested without a browser. The
 * components stay responsible for listening and for acting on the answer.
 * ========================================================================== */

export type SwipeIntent = "next" | "previous" | "none";

/**
 * Which post a swipe asks for.
 *
 * Vertical, like every other stories feed: the rail is a vertical column, the
 * wheel navigates on deltaY and the arrow keys are Up/Down, so a horizontal
 * swipe was the one gesture in the player pointing across its own grain.
 * Swiping up moves forward, the same direction as scrolling a page down.
 *
 * The axis has to dominate, not merely clear the threshold. A finger dragging
 * the article text up drifts sideways by well over the threshold, and the old
 * handler read only clientX — so scrolling a post could change the post.
 */
export function readSwipe(deltaX: number, deltaY: number, thresholdPx: number): SwipeIntent {
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return "none";
  if (Math.abs(deltaY) < thresholdPx) return "none";
  return deltaY < 0 ? "next" : "previous";
}

export type TapIntent = "previous-image" | "next-image" | "toggle-play";

/**
 * What a tap on the stage means, given where it landed across the frame.
 *
 * `ratio` is 0 at the left edge and 1 at the right. The edge bands only carry
 * meaning while the post actually has several images: on a single-image post
 * or a video the whole stage stays one big play/pause target, because silently
 * swallowing taps near the bezel would read as the player being broken.
 */
export function readTapIntent(ratio: number, hasGallery: boolean, edgeRatio: number): TapIntent {
  if (!hasGallery) return "toggle-play";
  if (ratio < edgeRatio) return "previous-image";
  if (ratio > 1 - edgeRatio) return "next-image";
  return "toggle-play";
}
