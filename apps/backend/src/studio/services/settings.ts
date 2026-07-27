import { eq } from "drizzle-orm";
import { fixUrlSlashes } from "../../content/message.js";
import type { BackendDb } from "../../db/client.js";
import { botSettings, botUiSettings, studioNotificationSettings } from "../../db/schema.js";
import { StudioError } from "../../foundation/errors.js";
import type { StudioActorId, StudioLocale } from "../contracts.js";

/** Read as a plain function, not a method: the service is an object literal, so
 * a method reading it through `this` breaks the moment it is destructured. */
function readNotifications(backendDb: BackendDb, actorId: StudioActorId) {
  const row = backendDb.db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.actorId, actorId)).get();
  return {
    remindersEnabled: row?.remindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
}

/** Owner settings commands used by Telegram today and any future Studio adapter. */
export function settingsService(backendDb: BackendDb) {
  return {
    notifications(actorId: StudioActorId) {
      return readNotifications(backendDb, actorId);
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
      const current = readNotifications(backendDb, actorId);
      const now = new Date().toISOString();
      const next = {
        remindersEnabled: input.remindersEnabled ?? current.remindersEnabled,
        reminderMinutes: input.reminderMinutes ?? current.reminderMinutes,
        completionEnabled: input.completionEnabled ?? current.completionEnabled,
      };
      backendDb.db
        .insert(studioNotificationSettings)
        .values({
          actorId: actorId,
          remindersEnabled: Number(next.remindersEnabled),
          reminderMinutes: next.reminderMinutes,
          completionEnabled: Number(next.completionEnabled),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: studioNotificationSettings.actorId,
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
      return backendDb.db.select().from(botSettings).where(eq(botSettings.actorId, actorId)).get()?.youtubeSignature.trim() ?? "";
    },
    beginYoutubeSignatureEdit(actorId: StudioActorId): void {
      const now = new Date().toISOString();
      backendDb.db
        .insert(botSettings)
        .values({ actorId: actorId, youtubeSignature: "", pendingAction: "youtube_signature", updatedAt: now })
        .onConflictDoUpdate({ target: botSettings.actorId, set: { pendingAction: "youtube_signature", updatedAt: now } })
        .run();
    },
    saveYoutubeSignature(actorId: StudioActorId, value: string): boolean {
      const setting = backendDb.db.select().from(botSettings).where(eq(botSettings.actorId, actorId)).get();
      if (setting?.pendingAction !== "youtube_signature") return false;
      backendDb.db
        .update(botSettings)
        .set({ youtubeSignature: value === "-" ? "" : fixUrlSlashes(value), pendingAction: null, updatedAt: new Date().toISOString() })
        .where(eq(botSettings.actorId, actorId))
        .run();
      return true;
    },
    clearYoutubeSignature(actorId: StudioActorId): void {
      const now = new Date().toISOString();
      backendDb.db
        .insert(botSettings)
        .values({ actorId: actorId, youtubeSignature: "", pendingAction: null, updatedAt: now })
        .onConflictDoUpdate({ target: botSettings.actorId, set: { youtubeSignature: "", pendingAction: null, updatedAt: now } })
        .run();
    },
    setLocale(actorId: StudioActorId, locale: StudioLocale): void {
      backendDb.db
        .insert(botUiSettings)
        .values({ actorId: actorId, locale, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({ target: botUiSettings.actorId, set: { locale, updatedAt: new Date().toISOString() } })
        .run();
    },
  };
}
