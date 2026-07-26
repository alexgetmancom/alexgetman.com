import { hubUrl } from "../server/hubs";

/** Links to an entity's canonical page: its hub when one collects it, otherwise
 * the generic listing. The hub condition used to be restated here and in both
 * `entities/[kind]/[slug]` routes; `hubUrl` derives it from the single hub table
 * so a new hub cannot half-exist. */
export function entityUrl(kind: string, slug: string, locale: "en" | "ru" = "en"): string {
  return hubUrl(kind, slug, locale) ?? `${locale === "ru" ? "/ru" : ""}/entities/${kind}/${slug}/`;
}
