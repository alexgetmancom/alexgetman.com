export function entityUrl(kind: string, slug: string, locale: "en" | "ru" = "en"): string {
  const prefix = locale === "ru" ? "/ru" : "";
  if (kind === "product" && (slug === "codex" || slug === "claude")) return `${prefix}/${slug}/`;
  return `${prefix}/entities/${kind}/${slug}/`;
}
