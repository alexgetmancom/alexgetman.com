/** Every Telegram sender in this codebase uses `parse_mode: "Markdown"` (legacy),
 * whose only special characters are `_ * [ ] \``. Escaping the MarkdownV2 set
 * here instead would render literal backslashes in front of dots, hyphens and
 * parentheses — so there is exactly one escaper, and it matches the parse mode
 * we actually send. Switching a sender to MarkdownV2 means adding a second
 * function here, not re-deriving one at the call site. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([_*[\]`])/g, "\\$1");
}
