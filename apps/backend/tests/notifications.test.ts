import { describe, expect, it } from "bun:test";
import { createDraftFromMessage } from "../src/content/drafts.js";
import { openBackendDb } from "../src/db/client.js";
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
});
