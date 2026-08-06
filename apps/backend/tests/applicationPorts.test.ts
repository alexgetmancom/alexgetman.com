import { describe, expect, it } from "bun:test";
import type { ApplicationPorts } from "../src/application/ports.js";
import { settingsService } from "../src/studio/services/settings.js";

describe("application persistence ports", () => {
  it("runs the settings service without SQLite", () => {
    let weeklyDigest: Parameters<ApplicationPorts["studioSettings"]["saveWeeklyDigest"]>[0] | undefined;
    let notifications: Parameters<ApplicationPorts["studioSettings"]["saveNotifications"]>[0] | undefined;
    let timezone: Parameters<ApplicationPorts["studioSettings"]["saveTimezone"]>[0] | undefined;
    let currentTimezone: string | null = null;
    const ports: Pick<ApplicationPorts, "clock" | "studioNotifications" | "studioSettings"> = {
      clock: { now: () => new Date("2026-01-02T03:04:05.000Z") },
      studioNotifications: {
        unread: () => [],
        get: () => null,
        acknowledge: () => false,
        cancelQueuedReminders: () => 0,
        draftOwner: () => null,
        videoOwner: () => null,
        postIdForKey: () => null,
        postOwner: () => null,
      },
      studioSettings: {
        notifications: () => null,
        locale: () => null,
        timezone: () => currentTimezone,
        weeklyDigest: () => null,
        saveWeeklyDigest: (input) => {
          weeklyDigest = input;
        },
        saveNotifications: (input) => {
          notifications = input;
        },
        botSettings: () => null,
        saveBotSettings: () => {},
        saveLocale: () => {},
        saveTimezone: (input) => {
          timezone = input;
          currentTimezone = input.timezone;
        },
      },
    };

    const settings = settingsService(ports);

    expect(settings.locale(42)).toBe("en");
    expect(settings.timezone(42, "Europe/Moscow")).toBe("Europe/Moscow");
    settings.setTimezone(42, "America/New_York");
    expect(timezone).toEqual({ timezone: "America/New_York", actorId: 42, updatedAt: "2026-01-02T03:04:05.000Z" });
    expect(settings.timezone(42, "Europe/Moscow")).toBe("America/New_York");
    expect(settings.setWeeklyDigest({ enabled: true, weekday: 2 })).toEqual({ enabled: true, weekday: 2 });
    expect(weeklyDigest).toEqual({ enabled: 1, weekday: 2, updatedAt: "2026-01-02T03:04:05.000Z" });
    expect(settings.setNotifications(42, { remindersEnabled: false, reminderMinutes: 15 })).toEqual({
      remindersEnabled: false,
      reminderMinutes: 15,
      completionEnabled: true,
    });
    expect(notifications).toEqual({
      actorId: 42,
      remindersEnabled: 0,
      reminderMinutes: 15,
      completionEnabled: 1,
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
  });
});
