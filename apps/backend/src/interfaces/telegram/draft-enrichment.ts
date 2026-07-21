import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };
type Candidate = { kind?: string; title_ru?: string; title_en?: string; slug?: string };
export type DraftEntityCandidate = {
  kind: "company" | "model" | "person" | "topic";
  slug: string;
  titleRu: string;
  titleEn: string | null;
};

/** A private editorial hint only. It never writes public metadata or changes a
 * draft, so a bad model answer cannot silently affect the site. */
export async function suggestDraftEntities(config: BackendConfig, text: string, urls: string[]): Promise<DraftEntityCandidate[]> {
  if (!config.DEEPSEEK_API_KEY || !text.trim()) return [];
  const response = await requestJson<ChatCompletion>(fetch, "https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-chat",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Extract only concrete AI-industry entities explicitly named in the supplied draft. Return strict JSON: {"entities":[{"kind":"company|model|person|topic","slug":"ascii-kebab-case","title_ru":"...","title_en":"..."}]}. Maximum five. Do not infer, explain, write copy, or use quotation marks.',
        },
        { role: "user", content: JSON.stringify({ text: text.slice(0, 4000), sources: urls.slice(0, 8) }) },
      ],
      signal: AbortSignal.timeout(30_000),
    }),
  });
  const content = response.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(content) as { entities?: Candidate[] };
  const entities = (parsed.entities ?? [])
    .flatMap((entity) => {
      const kind = ["company", "model", "person", "topic"].includes(entity.kind ?? "")
        ? (entity.kind as DraftEntityCandidate["kind"])
        : null;
      const slug = entity.slug
        ?.trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 80);
      const titleRu = entity.title_ru?.trim().replace(/\s+/g, " ").slice(0, 100);
      const titleEn = entity.title_en?.trim().replace(/\s+/g, " ").slice(0, 100) || null;
      return kind && slug && titleRu ? [{ kind, slug, titleRu, titleEn }] : [];
    })
    .slice(0, 5);
  return entities;
}
