/** Advice shown when captured media is likely to make delivery slow or fragile. */
export const RECOMMENDED_MEDIA_BYTES = 50_000_000;

export type MediaSizeAdvice = { megabytes: number; recommendedMegabytes: number };

/** The largest attached item over the recommendation, or null when all of them fit. */
export function mediaSizeAdvice(media: readonly Record<string, unknown>[]): MediaSizeAdvice | null {
  const largest = media.reduce((worst, item) => {
    const value = item.file_size;
    return Math.max(worst, typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
  if (largest <= RECOMMENDED_MEDIA_BYTES) return null;
  return { megabytes: megabytes(largest), recommendedMegabytes: megabytes(RECOMMENDED_MEDIA_BYTES) };
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}
