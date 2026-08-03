import { eq } from "drizzle-orm";
import type { StudioSettingsStore } from "../../application/ports.js";
import { botSettings, botUiSettings, studioNotificationSettings, studioWeeklyDigestSettings } from "../schema.js";
import type { BackendDatabase } from "../types.js";

/** SQLite adapter for owner and Studio-wide settings. */
export function createStudioSettingsStore(db: BackendDatabase): StudioSettingsStore {
  return {
    notifications(actorId) {
      return db.select().from(studioNotificationSettings).where(eq(studioNotificationSettings.actorId, actorId)).get() ?? null;
    },

    locale(actorId) {
      return db.select({ value: botUiSettings.locale }).from(botUiSettings).where(eq(botUiSettings.actorId, actorId)).get()?.value ?? null;
    },

    weeklyDigest() {
      return db.select().from(studioWeeklyDigestSettings).where(eq(studioWeeklyDigestSettings.id, 1)).get() ?? null;
    },

    saveWeeklyDigest(input) {
      db.insert(studioWeeklyDigestSettings)
        .values({ id: 1, enabled: input.enabled, weekday: input.weekday, updatedAt: input.updatedAt })
        .onConflictDoUpdate({
          target: studioWeeklyDigestSettings.id,
          set: { enabled: input.enabled, weekday: input.weekday, updatedAt: input.updatedAt },
        })
        .run();
    },

    saveNotifications(input) {
      db.insert(studioNotificationSettings)
        .values(input)
        .onConflictDoUpdate({
          target: studioNotificationSettings.actorId,
          set: {
            remindersEnabled: input.remindersEnabled,
            reminderMinutes: input.reminderMinutes,
            completionEnabled: input.completionEnabled,
            updatedAt: input.updatedAt,
          },
        })
        .run();
    },

    botSettings(actorId) {
      return db.select().from(botSettings).where(eq(botSettings.actorId, actorId)).get() ?? null;
    },

    saveBotSettings(input) {
      db.insert(botSettings)
        .values(input)
        .onConflictDoUpdate({
          target: botSettings.actorId,
          set: {
            youtubeSignature: input.youtubeSignature,
            pendingAction: input.pendingAction,
            updatedAt: input.updatedAt,
          },
        })
        .run();
    },

    saveLocale(input) {
      db.insert(botUiSettings)
        .values(input)
        .onConflictDoUpdate({
          target: botUiSettings.actorId,
          set: { locale: input.locale, updatedAt: input.updatedAt },
        })
        .run();
    },
  };
}
