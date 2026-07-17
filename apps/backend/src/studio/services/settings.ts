import { eq } from "drizzle-orm";
import { fixUrlSlashes } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { botSettings, botUiSettings, studioNotificationSettings } from "../../db/schema.js";
import { StudioError } from "../../foundation/errors.js";
import type { StudioActorId, StudioLocale } from "../contracts.js";

/** Owner settings commands used by Telegram today and any future Studio adapter. */
export function settingsService(backendDb: BackendDb) {
  return {
    notifications(actorId: StudioActorId) {
      const row = backendDb.db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.adminId, actorId)).get();
      return {
        remindersEnabled: row?.remindersEnabled !== 0,
        reminderMinutes: row?.reminderMinutes ?? 5,
        completionEnabled: row?.completionEnabled !== 0,
      };
    },
    setNotifications(
      actorId: StudioActorId,
      input: Partial<{ remindersEnabled: boolean; reminderMinutes: number; completionEnabled: boolean }>,
    ) {
      if (
        input.reminderMinutes != null &&
        (!Number.isInteger(input.reminderMinutes) || input.reminderMinutes < 1 || input.reminderMinutes > 60)
      )
        throw new StudioError("err.reminder-range");
      const current = this.notifications(actorId);
      const now = new Date().toISOString();
      const next = {
        remindersEnabled: input.remindersEnabled ?? current.remindersEnabled,
        reminderMinutes: input.reminderMinutes ?? current.reminderMinutes,
        completionEnabled: input.completionEnabled ?? current.completionEnabled,
      };
      backendDb.db
        .insert(studioNotificationSettings)
        .values({
          adminId: actorId,
          remindersEnabled: Number(next.remindersEnabled),
          reminderMinutes: next.reminderMinutes,
          completionEnabled: Number(next.completionEnabled),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: studioNotificationSettings.adminId,
          set: {
            remindersEnabled: Number(next.remindersEnabled),
            reminderMinutes: next.reminderMinutes,
            completionEnabled: Number(next.completionEnabled),
            updatedAt: now,
          },
        })
        .run();
      return next;
    },
    youtubeSignature(actorId: StudioActorId): string {
      return backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, actorId)).get()?.youtubeSignature.trim() ?? "";
    },
    beginYoutubeSignatureEdit(actorId: StudioActorId): void {
      const now = new Date().toISOString();
      backendDb.db
        .insert(botSettings)
        .values({ adminId: actorId, youtubeSignature: "", pendingAction: "youtube_signature", updatedAt: now })
        .onConflictDoUpdate({ target: botSettings.adminId, set: { pendingAction: "youtube_signature", updatedAt: now } })
        .run();
    },
    saveYoutubeSignature(actorId: StudioActorId, value: string): boolean {
      const setting = backendDb.db.select().from(botSettings).where(eq(botSettings.adminId, actorId)).get();
      if (setting?.pendingAction !== "youtube_signature") return false;
      backendDb.db
        .update(botSettings)
        .set({ youtubeSignature: value === "-" ? "" : fixUrlSlashes(value), pendingAction: null, updatedAt: new Date().toISOString() })
        .where(eq(botSettings.adminId, actorId))
        .run();
      return true;
    },
    clearYoutubeSignature(actorId: StudioActorId): void {
      const now = new Date().toISOString();
      backendDb.db
        .insert(botSettings)
        .values({ adminId: actorId, youtubeSignature: "", pendingAction: null, updatedAt: now })
        .onConflictDoUpdate({ target: botSettings.adminId, set: { youtubeSignature: "", pendingAction: null, updatedAt: now } })
        .run();
    },
    setLocale(actorId: StudioActorId, locale: StudioLocale): void {
      backendDb.db
        .insert(botUiSettings)
        .values({ adminId: actorId, locale, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: botUiSettings.adminId, set: { locale, updatedAt: new Date().toISOString() } })
        .run();
    },
  };
}
