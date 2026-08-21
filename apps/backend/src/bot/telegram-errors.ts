/** Telegram rejects an edit whose text and markup are byte-identical to what
 * the message already shows. Every periodic refresh hits this the moment
 * nothing has changed since the last tick, so it is the expected outcome, not
 * a failure -- but it arrives through the same throw as a broken parse_mode, a
 * deleted chat or a revoked permission, which are worth seeing in the logs.
 *
 * Kept in one place because the match is on Telegram's prose: two copies of
 * the string would drift apart the day the wording changes. */
export function isUnchangedMessageEdit(error: unknown): boolean {
  return String(error).includes("message is not modified");
}

/** Runs one message edit and lets the "nothing changed" rejection pass. Every
 * screen with a button that re-renders its own state (a page indicator, the
 * active period, "← Archive" while page one is open) meets it on a repeat tap;
 * every other failure still throws. */
export async function ignoringUnchangedEdit(edit: () => Promise<unknown>): Promise<void> {
  try {
    await edit();
  } catch (error) {
    if (!isUnchangedMessageEdit(error)) throw error;
  }
}
