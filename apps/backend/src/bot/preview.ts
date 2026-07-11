import { eq } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { formatMsk } from "../publishingSchedule.js";
import { requireDraft } from "./drafts.js";
import { parseTargets } from "./message.js";

export function draftPreview(backendDb: BackendDb, draftId: number): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const targets = parseTargets(draft.targets_json);
  const keyboard = new InlineKeyboard();
  keyboard
    .text("Full", `preset:full:${draftId}`)
    .text("RU only", `preset:ru:${draftId}`)
    .text("EN only", `preset:en:${draftId}`)
    .text("TG only", `preset:tg:${draftId}`)
    .row();
  for (let index = 0; index < TARGETS.length; index += 2) {
    for (const [target, label] of TARGETS.slice(index, index + 2))
      keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
    keyboard.row();
  }
  keyboard.text("Edit RU", `edit_ru:${draftId}`).text("Edit EN", `edit_en:${draftId}`).row();
  keyboard.text("Replace RU media", `replace_ru_media:${draftId}`).text("Replace EN media", `replace_en_media:${draftId}`).row();
  keyboard.text("Generate RU 9:16", `generate_story_ru:${draftId}`).text("Generate EN 9:16", `generate_story_en:${draftId}`).row();
  keyboard.text("Use RU media for EN", `use_ru_media:${draftId}`).row();
  keyboard.text("Publish now", `publish:${draftId}`).text("Schedule", `schedule:${draftId}`).row();
  keyboard.text("Cancel", `cancel:${draftId}`);
  const enabled =
    TARGETS.filter(([id]) => targets[id])
      .map(([, label]) => label)
      .join(", ") || "none";
  const schedule =
    draft.status === "scheduled"
      ? `\n\nScheduled RU: ${formatMsk(draft.scheduled_at)}\nScheduled EN: ${formatMsk(draft.scheduled_en_at)}`
      : "";
  return {
    text: `Draft #${draftId}\n\nRU:\n${String(draft.text_ru || "[media only]").slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || "[not translated]").slice(0, 1000)}\n\nTargets: ${enabled}${schedule}`,
    keyboard,
  };
}

export function toggleDraftTarget(backendDb: BackendDb, draftId: number, target: string): void {
  const row = backendDb.db.select({ targetsJson: drafts.targetsJson }).from(drafts).where(eq(drafts.id, draftId)).get();
  const targets = parseTargets(row?.targetsJson);
  targets[target] = !targets[target];
  backendDb.db
    .update(drafts)
    .set({ targetsJson: JSON.stringify(targets), updatedAt: new Date().toISOString() })
    .where(eq(drafts.id, draftId))
    .run();
}
