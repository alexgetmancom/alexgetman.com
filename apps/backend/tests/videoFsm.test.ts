import { describe, expect, it } from "bun:test";
import {
  advanceVideoMetadata,
  advanceVideoTargetSchedule,
  commonVideoSchedule,
  firstVideoMetadataStep,
  previousVideoMetadataStep,
} from "../src/studio/video-fsm.js";

describe("video metadata FSM", () => {
  it("selects the first required platform prompt", () => {
    expect(firstVideoMetadataStep(["youtube_shorts"])).toEqual({ step: "youtube_title", prompt: "youtube_title" });
    expect(firstVideoMetadataStep(["instagram_reels"])).toEqual({ step: "instagram_caption", prompt: "instagram_caption" });
  });

  it("advances YouTube metadata without Telegram state", () => {
    const title = advanceVideoMetadata("youtube_title", "My short", {});
    const description = advanceVideoMetadata("youtube_description", "-", title.data);
    const tags = advanceVideoMetadata("youtube_tags", "game, devlog", description.data);
    expect(title).toMatchObject({ nextStep: "youtube_description", prompt: "youtube_description" });
    expect(description.data.youtube_description).toBe("");
    expect(tags).toMatchObject({ nextStep: null, prompt: "schedule" });
    expect(tags.data.youtube_tags).toEqual(["game", "devlog"]);
  });

  it("reverses the YouTube chain step by step, and stops at its start", () => {
    const selected: ("youtube_shorts" | "instagram_reels")[] = ["youtube_shorts"];
    expect(previousVideoMetadataStep("youtube_description", selected)).toBe("youtube_title");
    expect(previousVideoMetadataStep("youtube_game_url", selected)).toBe("youtube_description");
    expect(previousVideoMetadataStep("youtube_tags", selected)).toBe("youtube_game_url");
    expect(previousVideoMetadataStep("youtube_title", selected)).toBeNull();
  });

  it("routes instagram_caption's back step depending on whether YouTube was also selected", () => {
    expect(previousVideoMetadataStep("instagram_caption", ["youtube_shorts", "instagram_reels"])).toBe("youtube_tags");
    expect(previousVideoMetadataStep("instagram_caption", ["instagram_reels"])).toBeNull();
  });

  it("advances independent and common schedules without Telegram state", () => {
    const selected = ["youtube_shorts", "instagram_reels"] as const;
    const first = advanceVideoTargetSchedule([...selected], {}, "youtube_shorts", new Date("2026-07-15T10:00:00.000Z"));
    expect(first.nextTarget).toBe("instagram_reels");
    const done = advanceVideoTargetSchedule([...selected], first.schedule, "instagram_reels", new Date("2026-07-15T11:00:00.000Z"));
    expect(done.nextTarget).toBeNull();
    expect(commonVideoSchedule([...selected], new Date("2026-07-15T10:00:00.000Z"))).toEqual({
      youtube_shorts: new Date("2026-07-15T10:00:00.000Z"),
      instagram_reels: new Date("2026-07-15T10:00:00.000Z"),
    });
  });
});
