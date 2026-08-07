import type { ApplicationPorts } from "../../application/ports.js";
import { fixUrlSlashes } from "../../content/message.js";
import type { BackendConfig } from "../../foundation/config.js";
import { StudioError } from "../../foundation/errors.js";
import { parseStudioLocale, type StudioLocale } from "../../foundation/locale.js";
import { isValidTimeZone, timeZoneOffsetLabel } from "../../foundation/time.js";

type SettingsDependencies = Pick<ApplicationPorts, "clock" | "studioNotifications" | "studioSettings">;

/** Read as a plain function, not a method: the service is an object literal, so
 * a method reading it through `this` breaks the moment it is destructured. */
function readNotifications(backendDb: SettingsDependencies, actorId: number) {
  const row = backendDb.studioSettings.notifications(actorId);
  return {
    remindersEnabled: row?.remindersEnabled !== 0,
    reminderMinutes: row?.reminderMinutes ?? 5,
    completionEnabled: row?.completionEnabled !== 0,
  };
}

function readLocale(backendDb: SettingsDependencies, actorId: number): StudioLocale {
  // English for an owner who never chose: the stored value is the only signal,
  // and an unset one predates the picker.
  return parseStudioLocale(backendDb.studioSettings.locale(actorId), "en");
}

function readTimezone(backendDb: SettingsDependencies, actorId: number, fallback: string): string {
  const timezone = backendDb.studioSettings.timezone(actorId)?.trim();
  return timezone && isValidTimeZone(timezone) ? timezone : fallback;
}

function writeYoutubeSignature(backendDb: SettingsDependencies, actorId: number, value: string): void {
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
    locale(actorId: number): StudioLocale {
      return readLocale(backendDb, actorId);
    },
    timezone(actorId: number, fallback: string): string {
      return readTimezone(backendDb, actorId, fallback);
    },
    timeConfig(
      actorId: number,
      config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
    ): Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL"> {
      const timezone = readTimezone(backendDb, actorId, config.TIMEZONE);
      return {
        TIMEZONE: timezone,
        TIMEZONE_LABEL:
          timezone === config.TIMEZONE ? config.TIMEZONE_LABEL : timeZoneOffsetLabel(timezone, readLocale(backendDb, actorId)),
      };
    },
    notifications(actorId: number) {
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
    setNotifications(actorId: number, input: Partial<{ remindersEnabled: boolean; reminderMinutes: number; completionEnabled: boolean }>) {
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
    youtubeSignature(actorId: number): string {
      return backendDb.studioSettings.botSettings(actorId)?.youtubeSignature.trim() ?? "";
    },
    setYoutubeSignature(actorId: number, value: string): void {
      writeYoutubeSignature(backendDb, actorId, value);
    },
    beginYoutubeSignatureEdit(actorId: number): void {
      const current = backendDb.studioSettings.botSettings(actorId);
      backendDb.studioSettings.saveBotSettings({
        actorId,
        youtubeSignature: current?.youtubeSignature ?? "",
        pendingAction: "youtube_signature",
        updatedAt: backendDb.clock.now().toISOString(),
      });
    },
    saveYoutubeSignature(actorId: number, value: string): boolean {
      const setting = backendDb.studioSettings.botSettings(actorId);
      if (setting?.pendingAction !== "youtube_signature") return false;
      writeYoutubeSignature(backendDb, actorId, value);
      return true;
    },
    clearYoutubeSignature(actorId: number): void {
      writeYoutubeSignature(backendDb, actorId, "-");
    },
    setLocale(actorId: number, locale: StudioLocale): void {
      backendDb.studioSettings.saveLocale({ actorId, locale, updatedAt: backendDb.clock.now().toISOString() });
    },
    setTimezone(actorId: number, timezone: string): void {
      const value = timezone.trim();
      if (!isValidTimeZone(value)) throw new StudioError("err.timezone-invalid");
      backendDb.studioSettings.saveTimezone({ actorId, timezone: value, updatedAt: backendDb.clock.now().toISOString() });
    },
  };
}
