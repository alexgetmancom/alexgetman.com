export function entityUrl(kind: string, slug: string, locale: "en" | "ru" = "en"): string {
  const prefix = locale === "ru" ? "/ru" : "";
  if ((kind === "product" && (slug === "codex" || slug === "claude")) || (kind === "model" && slug === "kimi-k3"))
    return `${prefix}/${slug === "kimi-k3" ? "kimi" : slug}/`;
  return `${prefix}/entities/${kind}/${slug}/`;
}
