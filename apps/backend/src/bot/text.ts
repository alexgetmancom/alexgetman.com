export function entitiesToHtml(text: string, entities: Record<string, unknown>[]): string {
  const sorted = [...entities]
    .map((entity) => ({ entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((item) => Number.isInteger(item.offset) && Number.isInteger(item.length) && item.offset >= 0 && item.length > 0)
    .sort((left, right) => right.offset - left.offset || left.length - right.length);
  let value = escapeHtml(text).replace(/\n/g, "<br>");
  for (const { entity, offset, length } of sorted) {
    const start = htmlOffset(text, offset);
    const end = htmlOffset(text, offset + length);
    if (start == null || end == null || start >= end) continue;
    const inner = value.slice(start, end);
    const type = String(entity.type ?? "");
    const wrapped =
      type === "bold"
        ? `<strong>${inner}</strong>`
        : type === "italic"
          ? `<em>${inner}</em>`
          : type === "underline"
            ? `<u>${inner}</u>`
            : type === "strikethrough"
              ? `<s>${inner}</s>`
              : type === "spoiler"
                ? `<span class="spoiler">${inner}</span>`
                : type === "code"
                  ? `<code>${inner}</code>`
                  : type === "pre"
                    ? `<pre><code>${inner}</code></pre>`
                    : type === "text_link" && typeof entity.url === "string"
                      ? `<a href="${escapeHtml(entity.url)}" rel="noopener noreferrer">${inner}</a>`
                      : type === "url"
                        ? `<a href="${inner}" rel="noopener noreferrer">${inner}</a>`
                        : inner;
    value = `${value.slice(0, start)}${wrapped}${value.slice(end)}`;
  }
  return value;
}

function htmlOffset(text: string, offset: number): number | null {
  if (offset < 0 || offset > text.length) return null;
  return escapeHtml(text.slice(0, offset)).replace(/\n/g, "<br>").length;
}

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (char) => entities[char] ?? char);
}
