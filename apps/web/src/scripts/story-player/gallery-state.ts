/** Посты с несколькими картинками (пост целиком не видео) листаются как
 * отдельные слайды перед переходом к следующему посту. Чистая функция
 * (мирроит audio-state.ts/discussion-state.ts) — сама смена индекса и решение
 * «остаться в посте или перейти дальше» вынесены из progress.ts/StoryPlayer.svelte,
 * чтобы их можно было проверить без DOM. */
export function advanceGallerySequence(subIndex: number, sequenceLength: number): { subIndex: number; advancePost: boolean } {
  if (subIndex + 1 < sequenceLength) return { subIndex: subIndex + 1, advancePost: false };
  return { subIndex, advancePost: true };
}
