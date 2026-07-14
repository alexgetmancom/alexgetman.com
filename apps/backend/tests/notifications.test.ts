import { describe, expect, it } from "bun:test";
import { openBackendDb } from "../src/db/client.js";
import { notificationService } from "../src/studio/services/notifications.js";
import { createVideoDraft } from "../src/video/service.js";

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
});
