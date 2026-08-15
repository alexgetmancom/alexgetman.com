import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { postEvents, studioNotificationJobs } from "../src/db/schema.js";
import { cancelScheduledNotifications, runNotificationCycle, scheduleReminder } from "../src/notifications/jobs.js";
import { postService } from "../src/studio/services/posts.js";
import { settingsService } from "../src/studio/services/settings.js";
import { registerTestChannels, TEXT_TEST_CHANNELS, VIDEO_TEST_CHANNELS } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

function openNotificationDb() {
  const memory = ":memory:";
  const backendDb = openBackendDb(memory);
  registerTestChannels(backendDb, [...TEXT_TEST_CHANNELS, ...VIDEO_TEST_CHANNELS]);
  return backendDb;
}

describe("Studio notifications", () => {
  it("creates durable interface-neutral reminders and honours cancellation", () => {
    const backendDb = openNotificationDb();
    try {
      const videoId = createTestVideoDraft(backendDb, 42, "owner-video", 24);
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
        backendDb.db.select().from(postEvents).where(eq(postEvents.eventType, "studio.notification.reminder.due")).get(),
      ).toBeDefined();

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
    const backendDb = openNotificationDb();
    try {
      scheduleReminder(backendDb, {
        actorId: 42,
        ref: "post:1",
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
    const backendDb = openNotificationDb();
    try {
      const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
      settingsService(backendDb).setNotifications(42, { reminderMinutes: 17 });
      const posts = postService(backendDb, config);
      const draftId = posts.create(42, { text: "Scheduled", textEn: "Scheduled", entities: [], media: [] });
      const postId = posts.schedule(42, draftId, { ruAt: new Date(Date.now() + 60 * 60_000), enAt: null });
      const job = backendDb.db
        .select()
        .from(studioNotificationJobs)
        .where(eq(studioNotificationJobs.ref, `post:${postId}`))
        .get();
      expect(job?.payloadJson).toMatchObject({ minutes: 17 });
    } finally {
      backendDb.close();
    }
  });

  it("cancels queued reminders when the owner disables reminders", () => {
    const backendDb = openNotificationDb();
    try {
      const videoId = createTestVideoDraft(backendDb, 42, "owner-video", 24);
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
