import { afterEach, describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { versionedCallback } from "../src/bot/session-fsm.js";
import { handleVideoActionCallback } from "../src/bot/video-actions.js";
import { getSession, saveSession } from "../src/bot/video-session.js";
import type { BackendDb } from "../src/db/client.js";
import { loadConfig } from "../src/foundation/config.js";
import { videoPreview } from "../src/interfaces/telegram/video-preview.js";
import { openBackendDb } from "./helpers/open-db.js";

let backendDb: BackendDb | null = null;

afterEach(() => {
  backendDb?.close();
  backendDb = null;
});

const config = loadConfig({ ADMIN_IDS: "42" });

function draftCard(status: string) {
  return {
    draft: { id: 7, label: "Clip", locale: "ru", status },
    targets: [{ id: 1, target: "youtube_shorts", status, metadataJson: { title: "Clip" }, scheduledAt: null }],
  };
}

describe("video card controls", () => {
  it("offers publishing now beside scheduling, like a text post card", () => {
    const keyboard = JSON.stringify(videoPreview(draftCard("draft"), config).keyboard);

    expect(keyboard).toContain("video_now:7");
    expect(keyboard).toContain("video_schedule:7");
  });

  it("drops both publication controls once the video leaves the draft states", () => {
    const keyboard = JSON.stringify(videoPreview(draftCard("scheduled"), config).keyboard);

    expect(keyboard).not.toContain("video_now:7");
    expect(keyboard).not.toContain("video_schedule:7");
  });
});

describe("video callback dispatch", () => {
  it("reports an unrouted video callback instead of answering it silently", async () => {
    backendDb = openBackendDb(":memory:");
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      callbackQuery: { data: "video_not_a_route:7" },
      from: { id: 42 },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    const handled = await handleVideoActionCallback(ctx, backendDb, config);

    // Still claimed by the video branch: falling through would reach the post
    // handler, which would answer a second time with "invalid post".
    expect(handled).toBe(true);
    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBeTruthy();
  });

  it("rejects a callback from an older video dialog revision", async () => {
    backendDb = openBackendDb(":memory:");
    const first = saveSession(backendDb, 42, { draftId: 7, step: "targets", selected: [], data: {} });
    saveSession(backendDb, 42, { ...first, selected: ["youtube_shorts"] });
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      callbackQuery: { data: versionedCallback("video_toggle:instagram_reels", first.revision) },
      from: { id: 42 },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    expect(await handleVideoActionCallback(ctx, backendDb, config)).toBe(true);
    expect(answers[0]?.text).toBe("This dialog is outdated. Start again.");
    expect(getSession(backendDb, 42)?.selected).toEqual(["youtube_shorts"]);
  });
});
