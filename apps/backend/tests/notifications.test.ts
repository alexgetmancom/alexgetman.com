import { describe, expect, it } from "bun:test";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { openBackendDb } from "../src/db/client.js";
import { cancelScheduledNotifications, runNotificationCycle, scheduleReminder } from "../src/notifications/jobs.js";
import { createVideoDraft } from "../src/publishing/video-service.js";
import { notificationService } from "../src/studio/services/notifications.js";

describe("Studio notifications", () => {
  it("keeps a durable inbox, suppresses cooled-down duplicates and acknowledges events", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const notifications = notificationService(backendDb);
      const ownedVideo = createVideoDraft(backendDb, 42, "owner-video", 24);
      const otherVideo = createVideoDraft(backendDb, 7, "other-video", 24);
      notifications.record({
        ref: `video:${ownedVideo}`,
        type: "video.target.failed",
        severity: "error",
        target: "youtube",
        message: "Upload failed",
        cooldownSeconds: 3600,
      });
      notifications.record({
        ref: `video:${ownedVideo}`,
        type: "video.target.failed",
        severity: "error",
        target: "youtube",
        message: "Upload failed",
        cooldownSeconds: 3600,
      });
      notifications.record({
        ref: `video:${otherVideo}`,
        type: "video.target.failed",
        severity: "error",
        target: "youtube",
        message: "Other upload failed",
      });
      notifications.record({ type: "worker.failed", severity: "error", message: "No target", cooldownSeconds: 3600 });
      notifications.record({ type: "worker.failed", severity: "error", message: "No target", cooldownSeconds: 3600 });
      const inbox = notifications.inbox(42);
      expect(inbox).toHaveLength(2);
      expect(inbox[0]?.eventType).toBe("video.target.failed");
      const id = inbox[0]?.id;
      if (!id) throw new Error("notification is missing id");
      expect(notifications.acknowledge(7, id)).toBe(false);
      expect(notifications.acknowledge(42, id)).toBe(true);
      expect(notifications.inbox(42)).toHaveLength(1);
      expect(notifications.inbox(7)).toHaveLength(2);
    } finally {
      backendDb.close();
    }
  });

  it("keeps Content and Publishing audit events visible only to the draft owner", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Private", entities: [], media: [] });
      const notifications = notificationService(backendDb);
      expect(notifications.inbox(42).some((event) => event.eventType === "content.draft.created")).toBe(true);
      expect(notifications.inbox(7).some((event) => event.postKey === `draft:${draftId}`)).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("creates durable interface-neutral reminders and honours cancellation", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const videoId = createVideoDraft(backendDb, 42, "owner-video", 24);
      scheduleReminder(backendDb, {
        adminId: 42,
        ref: `video:${videoId}`,
        kind: "video.youtube_shorts",
        publishAt: new Date(Date.now() + 30_000),
        title: "Launch",
        targets: ["youtube_shorts"],
        preference: { remindersEnabled: true, reminderMinutes: 5, completionEnabled: true },
      });
      expect(runNotificationCycle(backendDb)).toBe(1);
      expect(
        notificationService(backendDb)
          .inbox(42)
          .some((event) => event.eventType === "studio.notification.reminder.due"),
      ).toBe(true);

      scheduleReminder(backendDb, {
        adminId: 42,
        ref: `video:${videoId}`,
        kind: "video.instagram_reels",
        publishAt: new Date(Date.now() + 60 * 60_000),
        title: "Launch",
        targets: ["instagram_reels"],
        preference: { remindersEnabled: true, reminderMinutes: 5, completionEnabled: true },
      });
      cancelScheduledNotifications(backendDb, `video:${videoId}`);
      expect(runNotificationCycle(backendDb)).toBe(0);
    } finally {
      backendDb.close();
    }
  });
});
