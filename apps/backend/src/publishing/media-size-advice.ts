/**
 * What we recommend an operator attach, checked the moment the material arrives.
 *
 * This is advice, not a limit: `STUDIO_MEDIA_MAX_BYTES` is the only thing that
 * refuses a file. A gigabyte video passes every check we have and then spends
 * ten minutes in `prepare` before Threads answers `UNKNOWN` on the container,
 * so the operator hears about it hours later through a failed target. Saying it
 * at capture time costs one field Telegram already sends.
 */
export const RECOMMENDED_MEDIA_BYTES = 50_000_000;

export type MediaSizeAdvice = { megabytes: number; recommendedMegabytes: number };

/** The largest attached item over the recommendation, or null when all of them
 * fit. Items Telegram sent no size for simply do not participate. */
export function mediaSizeAdvice(media: readonly Record<string, unknown>[]): MediaSizeAdvice | null {
  const largest = media.reduce((worst, item) => Math.max(worst, byteSize(item)), 0);
  if (largest <= RECOMMENDED_MEDIA_BYTES) return null;
  return { megabytes: megabytes(largest), recommendedMegabytes: megabytes(RECOMMENDED_MEDIA_BYTES) };
}

function byteSize(item: Record<string, unknown>): number {
  const value = item.file_size;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function megabytes(bytes: number): number {
  return Math.round(bytes / 1_000_000);
}
