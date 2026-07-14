function hasBlockHtml(value: string): boolean {
  return /<(p|ul|ol|li|pre|blockquote|h2|h3|table|figure|div)\b/i.test(value);
}

function paragraphizeLines(lines: string[]): string {
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line) {
      index += 1;
      continue;
    }
    const bulletItems: string[] = [];
    while (index < lines.length) {
      const match = lines[index].trim().match(/^(?:[-*•])\s+(.+)$/);
      if (!match) break;
      bulletItems.push(match[1]);
      index += 1;
    }
    if (bulletItems.length) {
      blocks.push(`<ul>${bulletItems.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      continue;
    }
    const numberedItems: string[] = [];
    while (index < lines.length) {
      const match = lines[index].trim().match(/^\d+[.)]\s+(.+)$/);
      if (!match) break;
      numberedItems.push(match[1]);
      index += 1;
    }
    if (numberedItems.length) {
      blocks.push(`<ol>${numberedItems.map((item) => `<li>${item}</li>`).join("")}</ol>`);
      continue;
    }
    blocks.push(`<p>${line}</p>`);
    index += 1;
  }
  return blocks.join("\n");
}

export function semanticPostHtml(value: string): string {
  const html = String(value || "").trim();
  if (!html || hasBlockHtml(html)) return html;
  return html
    .replace(/\r\n/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split(/\n{2,}/)
    .map((chunk) => paragraphizeLines(chunk.split("\n")))
    .filter(Boolean)
    .join("\n");
}
