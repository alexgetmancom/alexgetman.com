import { describe, expect, it } from "bun:test";
import { backFlow } from "../src/application/conversation-flow.js";
import {
  advanceVideoMetadata,
  advanceVideoTargetSchedule,
  commonVideoSchedule,
  firstVideoMetadataStep,
  VIDEO_FLOW,
} from "../src/studio/video-fsm.js";

function previousStep(step: string, selected: ("youtube_shorts" | "instagram_reels")[]): string | null {
  return backFlow(VIDEO_FLOW, step, { selectedTargets: selected });
}

describe("video metadata FSM", () => {
  it("selects the first required platform prompt", () => {
    expect(firstVideoMetadataStep(["youtube_shorts"])).toBe("youtube_title");
    expect(firstVideoMetadataStep(["instagram_reels"])).toBe("instagram_caption");
  });

  it("advances YouTube metadata without Telegram state", () => {
    const title = advanceVideoMetadata("youtube_title", "My short", {});
    const description = advanceVideoMetadata("youtube_description", "-", title.data);
    const tags = advanceVideoMetadata("youtube_tags", "game, devlog", description.data);
    expect(title).toMatchObject({ nextStep: "youtube_description" });
    expect(description.data.youtube_description).toBe("");
    expect(tags).toMatchObject({ nextStep: null });
    expect(tags.data.youtube_tags).toEqual(["game", "devlog"]);
  });

  it("reverses the YouTube chain step by step, and stops at its start", () => {
    const selected: ("youtube_shorts" | "instagram_reels")[] = ["youtube_shorts"];
    expect(previousStep("youtube_description", selected)).toBe("youtube_title");
    expect(previousStep("youtube_game_url", selected)).toBe("youtube_description");
    expect(previousStep("youtube_tags", selected)).toBe("youtube_game_url");
    expect(previousStep("youtube_title", selected)).toBeNull();
  });

  it("routes instagram_caption's back step depending on whether YouTube was also selected", () => {
    expect(previousStep("instagram_caption", ["youtube_shorts", "instagram_reels"])).toBe("youtube_tags");
    expect(previousStep("instagram_caption", ["instagram_reels"])).toBeNull();
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
