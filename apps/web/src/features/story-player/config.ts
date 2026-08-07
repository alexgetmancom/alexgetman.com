/* =============================================================================
 * PLAYER CONSTANTS AND CONFIG
 * -----------------------------------------------------------------------------
 * What lives here: the "desktop" breakpoint, the advance timings.
 * A new constant (a "magic number") goes here with a comment, not into a
 * component.
 * ========================================================================== */

/** How long a post without video is shown before advancing (ms). */
export const storyIntervalMs = 8500;

/** Vertical swipe distance that counts as "next post" (px), and the mouse
 * wheel cooldown (ms). Both navigate along the same axis as the rail. */
export const swipeThresholdPx = 55;
export const wheelCooldownMs = 140;
