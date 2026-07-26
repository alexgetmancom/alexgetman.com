import { compactText } from "./text";

const ENTITY_PATTERN =
  /\b(?:AI|API|LLM|GPT-\d+|Claude(?:\s+Code)?|Codex|Gemini|OpenAI|Anthropic|Google|GitHub|Telegram|Docker|Bun|TypeScript|Astro)\b/gi;

/** Matching is case-insensitive, so the dedupe has to be too: keyed on the raw
 * match, "AI" and "ai" (or "Claude" and "claude") both survived as separate
 * entities in one item's list. The canonical spelling wins. */
const CANONICAL_ENTITIES = [
  "AI",
  "API",
  "LLM",
  "Claude Code",
  "Claude",
  "Codex",
  "Gemini",
  "OpenAI",
  "Anthropic",
  "Google",
  "GitHub",
  "Telegram",
  "Docker",
  "Bun",
  "TypeScript",
  "Astro",
];

function canonicalEntity(term: string): string {
  const collapsed = term.replace(/\s+/g, " ").trim();
  return CANONICAL_ENTITIES.find((name) => name.toLowerCase() === collapsed.toLowerCase()) ?? collapsed.toUpperCase();
}

/** Entities named in a post, for the machine-readable feed (`/feed-ai.json`). */
export function keyEntities(value: string, limit = 12): string[] {
  const terms = compactText(value).match(ENTITY_PATTERN) ?? [];
  return [...new Set(terms.map(canonicalEntity))].slice(0, limit);
}
