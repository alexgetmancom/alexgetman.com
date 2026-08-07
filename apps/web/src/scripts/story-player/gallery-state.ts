/** A post with several images (and no video of its own) pages through them as
 * separate slides before moving to the next post. A pure function, mirroring
 * audio-state.ts: advancing the index and deciding "stay on this post or move
 * on" are lifted out of progress.ts/StoryPlayer.svelte so they can be tested
 * without a DOM. */
export function advanceGallerySequence(subIndex: number, sequenceLength: number): { subIndex: number; advancePost: boolean } {
  if (subIndex + 1 < sequenceLength) return { subIndex: subIndex + 1, advancePost: false };
  return { subIndex, advancePost: true };
}
