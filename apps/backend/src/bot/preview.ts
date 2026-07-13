import { eq } from "drizzle-orm";
import { InlineKeyboard } from "grammy";
import { PRESETS, TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { drafts } from "../db/schema.js";
import { formatMsk } from "../publishing/schedule.js";
import { requireDraft } from "./drafts.js";
import { parseTargets } from "./message.js";

export type DraftView = "overview" | "modes" | "schedule" | "confirm_publish" | "platforms";

export function draftPreview(
  backendDb: BackendDb,
  draftId: number,
  view: DraftView = "overview",
): { text: string; keyboard: InlineKeyboard } {
  const draft = requireDraft(backendDb, draftId);
  const targets = parseTargets(draft.targets_json);
  const keyboard = new InlineKeyboard();
  const mode = draftMode(targets);

  if (view === "platforms") {
    // Render toggles in columns of 2
    for (let index = 0; index < TARGETS.length; index += 2) {
      for (const [target, label] of TARGETS.slice(index, index + 2)) {
        keyboard.text(`${targets[target] ? "✓" : "□"} ${label}`, `toggle:${draftId}:${target}`);
      }
      keyboard.row();
    }
    keyboard.text("← Back to preview", `preview:${draftId}`).row();

    const enabled =
      TARGETS.filter(([id]) => targets[id])
        .map(([, label]) => label)
        .join(", ") || "none";
    return {
      text: `📝 *Choose platforms for post #${draftId}*\n\nActive: *${enabled}*\n\nToggle platforms below:`,
      keyboard,
    };
  }

  if (view === "schedule") {
    keyboard
      .text("📥 Auto next slot", `sched_auto:${draftId}`)
      .text("+30 min", `sched_preset:plus30:${draftId}`)
      .row()
      .text("+1 hour", `sched_preset:plus60:${draftId}`)
      .text("Today 21:00", `sched_preset:today2100:${draftId}`)
      .row()
      .text("Tomorrow 10:00", `sched_preset:tomorrow1000:${draftId}`)
      .row()
      .text("Enter time manually", `sched_manual:both:${draftId}`)
      .row()
      .text("← Back", `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets)}\n\n📅 *Scheduling*\nSelect slot or enter manually:`,
      keyboard,
    };
  }

  if (view === "confirm_publish") {
    const enabled = enabledTargetLabels(targets);
    keyboard.text("✅ Yes, publish now", `publish_confirm:${draftId}`).text("← Back", `preview:${draftId}`);
    return {
      text: `${draftHeader(draftId, targets)}\n\n⚠️ *Confirm publication now*\nTo be sent to: ${enabled || "no platforms selected"}.`,
      keyboard,
    };
  }

  // overview view
  const modeEmoji = mode === "manual" ? "🛞" : "⚙️";
  keyboard.text(`${modeEmoji} Mode: ${modeLabel(mode)}`, `cycle_mode:${draftId}`).row();
  keyboard.text("🌐 Choose platforms", `platforms:${draftId}`).row();

  keyboard.text("Edit RU", `edit_ru:${draftId}`).text("Edit EN", `edit_en:${draftId}`).row();
  keyboard.text("▶️ Publish now", `publish:${draftId}`).text("📅 Schedule", `schedule:${draftId}`).row();
  keyboard.text("Cancel", `cancel:${draftId}`);

  const schedule =
    draft.status === "scheduled"
      ? `\n\nScheduled RU: ${formatMsk(draft.scheduled_at ? String(draft.scheduled_at) : null)}\nScheduled EN: ${formatMsk(draft.scheduled_en_at ? String(draft.scheduled_en_at) : null)}`
      : "";

  return {
    text: `${draftHeader(draftId, targets)}\n\nRU:\n${String(draft.text_ru || "[media only]").slice(0, 1000)}\n\nEN:\n${String(draft.text_en_approved || draft.text_en_machine || "[not translated]").slice(0, 1000)}${schedule}`,
    keyboard,
  };
}

function draftHeader(draftId: number, targets: Record<string, boolean>): string {
  return `📝 *Post #${draftId}*\nMode: *${modeLabel(draftMode(targets))}* · Platforms: *${Object.values(targets).filter(Boolean).length}*`;
}

function enabledTargetLabels(targets: Record<string, boolean>): string {
  return TARGETS.filter(([id]) => targets[id])
    .map(([, label]) => label)
    .join(", ");
}

export function draftMode(targets: Record<string, boolean>): keyof typeof PRESETS | "manual" {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (TARGETS.every(([target]) => Boolean(targets[target]) === Boolean(preset[target]))) return name as keyof typeof PRESETS;
  }
  return "manual";
}

export function modeLabel(mode: keyof typeof PRESETS | "manual"): string {
  switch (mode) {
    case "full":
      return "Full";
    case "ru":
      return "RU only";
    case "en":
      return "EN only";
    case "tg":
      return "TG only";
    default:
      return "Manual";
  }
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
