import type { ApplicationPorts } from "../../application/ports.js";
import { fixUrlSlashes } from "../../content/message.js";
import { StudioError } from "../../foundation/errors.js";
import type { StudioActorId, StudioLocale } from "../contracts.js";

type SettingsDependencies = Pick<ApplicationPorts, "clock" | "studioNotifications" | "studioSettings">;

/** Read as a plain function, not a method: the service is an object literal, so
 * a method reading it through `this` breaks the moment it is destructured. */
function readNotifications(backendDb: SettingsDependencies, actorId: StudioActorId) {
  const row = backendDb.studioSettings.notifications(actorId);
  return {
    remindersEnabled: row?.remindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
}

function readLocale(backendDb: SettingsDependencies, actorId: StudioActorId): StudioLocale {
  return backendDb.studioSettings.locale(actorId) === "ru" ? "ru" : "en";
}

function writeYoutubeSignature(backendDb: SettingsDependencies, actorId: StudioActorId, value: string): void {
  const signature = value === "-" ? "" : fixUrlSlashes(value);
  backendDb.studioSettings.saveBotSettings({
    actorId,
    youtubeSignature: signature,
    pendingAction: null,
    updatedAt: backendDb.clock.now().toISOString(),
  });
}

function readWeeklyDigest(backendDb: SettingsDependencies) {
  const row = backendDb.studioSettings.weeklyDigest();
  return { enabled: row?.enabled !== 0, weekday: row?.weekday ?? 0 };
}

/** Owner settings commands used by Telegram today and any future Studio adapter. */
export function settingsService(backendDb: SettingsDependencies) {
  return {
    locale(actorId: StudioActorId): StudioLocale {
      return readLocale(backendDb, actorId);
    },
    notifications(actorId: StudioActorId) {
      return readNotifications(backendDb, actorId);
    },
    weeklyDigest() {
      return readWeeklyDigest(backendDb);
    },
    setWeeklyDigest(input: Partial<{ enabled: boolean; weekday: number }>) {
      if (input.weekday != null && (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6))
        throw new StudioError("err.weekday-range");
      const current = readWeeklyDigest(backendDb);
      const next = { enabled: input.enabled ?? current.enabled, weekday: input.weekday ?? current.weekday };
      backendDb.studioSettings.saveWeeklyDigest({
        enabled: Number(next.enabled),
        weekday: next.weekday,
        updatedAt: backendDb.clock.now().toISOString(),
      });
      return next;
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
      const now = backendDb.clock.now().toISOString();
      const next = {
        remindersEnabled: input.remindersEnabled ?? current.remindersEnabled,
        reminderMinutes: input.reminderMinutes ?? current.reminderMinutes,
        completionEnabled: input.completionEnabled ?? current.completionEnabled,
      };
      backendDb.studioSettings.saveNotifications({
        actorId,
        remindersEnabled: Number(next.remindersEnabled),
        reminderMinutes: next.reminderMinutes,
        completionEnabled: Number(next.completionEnabled),
        updatedAt: now,
      });
      if (current.remindersEnabled && !next.remindersEnabled) backendDb.studioNotifications.cancelQueuedReminders(actorId, now);
      return next;
    },
    youtubeSignature(actorId: StudioActorId): string {
      return backendDb.studioSettings.botSettings(actorId)?.youtubeSignature.trim() ?? "";
    },
    setYoutubeSignature(actorId: StudioActorId, value: string): void {
      writeYoutubeSignature(backendDb, actorId, value);
    },
    beginYoutubeSignatureEdit(actorId: StudioActorId): void {
      const current = backendDb.studioSettings.botSettings(actorId);
      backendDb.studioSettings.saveBotSettings({
        actorId,
        youtubeSignature: current?.youtubeSignature ?? "",
        pendingAction: "youtube_signature",
        updatedAt: backendDb.clock.now().toISOString(),
      });
    },
    saveYoutubeSignature(actorId: StudioActorId, value: string): boolean {
      const setting = backendDb.studioSettings.botSettings(actorId);
      if (setting?.pendingAction !== "youtube_signature") return false;
      writeYoutubeSignature(backendDb, actorId, value);
      return true;
    },
    clearYoutubeSignature(actorId: StudioActorId): void {
      writeYoutubeSignature(backendDb, actorId, "-");
    },
    setLocale(actorId: StudioActorId, locale: StudioLocale): void {
      backendDb.studioSettings.saveLocale({ actorId, locale, updatedAt: backendDb.clock.now().toISOString() });
    },
  };
}
