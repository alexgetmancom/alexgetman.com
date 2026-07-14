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

export function formatViewsCount(views: number): string {
  if (!views) return "0";
  if (views >= 1_000_000) return `${(views / 1_000_000).toFixed(1).replace(".0", "")}M`;
  return views >= 1000 ? `${(views / 1000).toFixed(1).replace(".0", "")}K` : views.toString();
}

export function sanitizeHtml(htmlStr: string): string {
  if (!htmlStr) return "";
  const tags = new Set([
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "del",
    "div",
    "em",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "s",
    "span",
    "strong",
    "u",
    "ul",
  ]);
  const classTags = new Set(["code", "pre", "span", "div", "p"]);
  return htmlStr.replace(/<\/?[A-Za-z][^>]*>/g, (tag) => {
    const closing = /^<\//.test(tag);
    const name = tag.match(/^<\/?\s*([A-Za-z0-9]+)/)?.[1]?.toLowerCase();
    if (!name || !tags.has(name)) return "";
    if (closing) return `</${name}>`;
    if (name === "br") return "<br>";
    const attributes: string[] = [];
    if (name === "a") {
      const href = tag.match(/\bhref\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      if (href && /^(https?:|mailto:|tg:)/i.test(href)) attributes.push(`href="${escapeHtmlAttribute(href)}"`);
      const target = tag.match(/\btarget\s*=\s*["']?([^"'\s>]+)/i)?.[1];
      if (target === "_blank") attributes.push('target="_blank"');
      attributes.push('rel="noopener noreferrer"');
    } else if (classTags.has(name)) {
      const className = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1];
      if (className) attributes.push(`class="${escapeHtmlAttribute(className.replace(/[^A-Za-z0-9 _-]/g, ""))}"`);
    }
    return `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  });
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] ?? char);
}
