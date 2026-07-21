import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";

type ChatCompletion = { choices?: Array<{ message?: { content?: string } }> };
type Candidate = { kind?: string; name?: string };

/** A private editorial hint only. It never writes public metadata or changes a
 * draft, so a bad model answer cannot silently affect the site. */
export async function draftEntityHint(config: BackendConfig, text: string, urls: string[]): Promise<string | null> {
  if (!config.DEEPSEEK_API_KEY || !text.trim()) return null;
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
            'Extract only concrete AI-industry entities explicitly named in the supplied draft. Return strict JSON: {"entities":[{"kind":"company|model|person|topic","name":"..."}]}. Maximum five. Do not infer, explain, write copy, or use quotation marks.',
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
      const kind = ["company", "model", "person", "topic"].includes(entity.kind ?? "") ? entity.kind : null;
      const name = entity.name?.trim().replace(/\s+/g, " ").slice(0, 80);
      return kind && name ? [{ kind, name }] : [];
    })
    .slice(0, 5);
  if (entities.length === 0) return null;
  const labels: Record<string, string> = { company: "Компания", model: "Модель", person: "Человек", topic: "Тема" };
  return `ИИ нашёл сущности, пока только как подсказку:\n${entities.map((entity) => `• ${labels[entity.kind]}: ${entity.name}`).join("\n")}`;
}
