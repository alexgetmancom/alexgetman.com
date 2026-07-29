/**
 * Site and Story delivery intentionally share one short-form derivative.
 * Keeping the recipe identity in one place makes equal source bytes converge
 * on the same VM-106 cache entry, regardless of which durable job arrives first.
 */
const VERTICAL_MEDIA_RECIPE = "vertical-variants-v6";
export const VERTICAL_MEDIA_TRANSFORM = "story_vertical";

export function verticalMediaRecipe(kind: "video" | "image"): string {
  return `${VERTICAL_MEDIA_RECIPE}:${kind}`;
}
