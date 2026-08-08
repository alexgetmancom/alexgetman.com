/** Legacy Markdown is this application's one markup flavour: the Telegram
 * senders emit it, and so do the analytics report builders, which is why the
 * escaper lives in foundation rather than under an interface — an archive report
 * had to reach into `interfaces/telegram/` just to escape a video's title.
 *
 * Every Telegram sender in this codebase uses `parse_mode: "Markdown"` (legacy),
 * whose special characters are `\ _ * [ ] \``. Escaping the MarkdownV2 set
 * here instead would render literal backslashes in front of dots, hyphens and
 * parentheses — so there is exactly one escaper, and it matches the parse mode
 * we actually send. Switching a sender to MarkdownV2 means adding a second
 * function here, not re-deriving one at the call site. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\_*[\]`])/g, "\\$1");
}
