import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { postEvents, studioNotificationJobs } from "../src/db/schema.js";
import { loadConfig } from "../src/foundation/config.js";
import { cancelScheduledNotifications, runNotificationCycle, scheduleReminder } from "../src/notifications/jobs.js";
import { createVideoDraft } from "../src/publishing/video-service.js";
import { notificationService } from "../src/studio/services/notifications.js";
import { postService } from "../src/studio/services/posts.js";
import { settingsService } from "../src/studio/services/settings.js";
import { openBackendDb } from "./helpers/open-db.js";

describe("Studio notifications", () => {
  it("shares the durable inbox across configured administrators", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const notifications = notificationService(backendDb, loadConfig({ ADMIN_IDS: "42,7" }));
      const videoId = createVideoDraft(backendDb, 42, "shared-video", 24);
      notifications.record({
        ref: `video:${videoId}`,
        type: "delivery.video.completed",
        severity: "info",
        message: "Shared completion",
      });
      const event = notifications.inbox(7)[0];
      expect(event?.message).toBe("Shared completion");
      expect(event && notifications.acknowledge(7, event.id)).toBe(true);
      expect(notifications.inbox(42)).toHaveLength(0);
    } finally {
      backendDb.close();
    }
  });

  it("keeps a durable inbox, suppresses cooled-down duplicates and acknowledges events", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const notifications = notificationService(backendDb);
      const ownedVideo = createVideoDraft(backendDb, 42, "owner-video", 24);
      const otherVideo = createVideoDraft(backendDb, 7, "other-video", 24);
      notifications.record({
        ref: `video:${ownedVideo}`,
        type: "studio.notification.reminder.due",
        severity: "info",
        target: "youtube",
        message: "Upload is due",
        cooldownSeconds: 3600,
      });
      notifications.record({
        ref: `video:${ownedVideo}`,
        type: "studio.notification.reminder.due",
        severity: "info",
        target: "youtube",
        message: "Upload is due",
        cooldownSeconds: 3600,
      });
      notifications.record({
        ref: `video:${otherVideo}`,
        type: "studio.notification.reminder.due",
        severity: "info",
        target: "youtube",
        message: "Other upload is due",
      });
      notifications.record({ type: "worker.failed", severity: "error", message: "No target", cooldownSeconds: 3600 });
      notifications.record({ type: "worker.failed", severity: "error", message: "No target", cooldownSeconds: 3600 });
      const inbox = notifications.inbox(42);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]?.eventType).toBe("studio.notification.reminder.due");
      const id = inbox[0]?.id;
      if (!id) throw new Error("notification is missing id");
      expect(notifications.acknowledge(7, id)).toBe(false);
      expect(notifications.acknowledge(42, id)).toBe(true);
      expect(notifications.inbox(42)).toHaveLength(0);
      expect(notifications.inbox(7)).toHaveLength(1);

      const auditEvent = backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, "worker.failed")).get();
      if (!auditEvent) throw new Error("audit event is missing");
      expect(notifications.acknowledge(42, auditEvent.id)).toBe(false);
      expect(backendDb.db.select().from(postEvents).where(eq(postEvents.id, auditEvent.id)).get()?.ackedAt).toBeNull();
    } finally {
      backendDb.close();
    }
  });

  it("keeps Content and Publishing audit events out of the creator inbox", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Private", entities: [], media: [] });
      const notifications = notificationService(backendDb);
      expect(notifications.inbox(42).some((event) => event.eventType === "content.draft.created")).toBe(false);
      expect(notifications.inbox(7).some((event) => event.postKey === `draft:${draftId}`)).toBe(false);
    } finally {
      backendDb.close();
    }
  });

  it("does not fall open on a post ref whose id is not a number", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const notifications = notificationService(backendDb);
      notifications.record({ ref: "post:abc", type: "delivery.post.completed", severity: "info", message: "Broken ref" });
      expect(notifications.inbox(42)).toHaveLength(0);
      expect(notifications.inbox(7)).toHaveLength(0);
    } finally {
      backendDb.close();
    }
  });

  it("creates durable interface-neutral reminders and honours cancellation", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const videoId = createVideoDraft(backendDb, 42, "owner-video", 24);
      scheduleReminder(backendDb, {
        actorId: 42,
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
        actorId: 42,
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

  it("does not remind about a publication that is already due", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: "publication:post:1",
        kind: "post.en",
        publishAt: new Date(Date.now() - 1_000),
        title: "Immediate publication",
        targets: ["threads_en"],
        preference: { remindersEnabled: true, reminderMinutes: 5, completionEnabled: true },
      });

      expect(backendDb.db.select().from(studioNotificationJobs).all()).toHaveLength(0);
    } finally {
      backendDb.close();
    }
  });

  it("uses the owner's stored reminder interval when scheduling a post", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const config = loadConfig({ ADMIN_IDS: "42" });
      settingsService(backendDb).setNotifications(42, { reminderMinutes: 17 });
      const posts = postService(backendDb, config);
      const draftId = posts.create(42, { text: "Scheduled", textEn: "Scheduled", entities: [], media: [] });
      const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60 * 60_000), enAt: null });
      const job = backendDb.db
        .select()
        .from(studioNotificationJobs)
        .where(eq(studioNotificationJobs.ref, `publication:post:${postId}`))
        .get();
      expect(job?.payloadJson).toMatchObject({ minutes: 17 });
    } finally {
      backendDb.close();
    }
  });

  it("cancels queued reminders when the owner disables reminders", () => {
    const backendDb = openBackendDb(":memory:");
    try {
      const videoId = createVideoDraft(backendDb, 42, "owner-video", 24);
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: `video:${videoId}`,
        kind: "video.youtube_shorts",
        publishAt: new Date(Date.now() + 60 * 60_000),
        title: "Launch",
        targets: ["youtube_shorts"],
        preference: { remindersEnabled: true, reminderMinutes: 5, completionEnabled: true },
      });

      settingsService(backendDb).setNotifications(42, { remindersEnabled: false });

      expect(backendDb.db.select({ status: studioNotificationJobs.status }).from(studioNotificationJobs).all()).toEqual([
        { status: "cancelled" },
      ]);
    } finally {
      backendDb.close();
    }
  });
});
