import { describe, expect, it } from "bun:test";
import { acceptFlow, backFlow } from "../src/application/conversation-flow.js";
import { firstVideoMetadataStep, VIDEO_FLOW } from "../src/studio/video-fsm.js";

function previousStep(step: string, selected: ("youtube_shorts" | "instagram_reels")[]): string | null {
  return backFlow(VIDEO_FLOW, step, { selectedTargets: selected });
}

describe("video metadata FSM", () => {
  it("selects the first required platform prompt", () => {
    expect(firstVideoMetadataStep(["youtube_shorts"])).toBe("youtube_title");
    expect(firstVideoMetadataStep(["instagram_reels"])).toBe("instagram_caption");
  });

  it("advances YouTube metadata without Telegram state", async () => {
    const title = await acceptFlow(VIDEO_FLOW, "youtube_title", "My short", {});
    const description = await acceptFlow(VIDEO_FLOW, "youtube_description", "-", title?.data ?? {});
    const tags = await acceptFlow(VIDEO_FLOW, "youtube_tags", "game, devlog", description?.data ?? {});
    expect(title?.next).toBe("youtube_description");
    expect(description?.data.youtube_description).toBe("");
    expect(tags?.next).toBe("schedule_choice");
    expect(tags?.data.youtube_tags).toEqual(["game", "devlog"]);
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

  it("advances independent and common schedules without Telegram state", async () => {
    const selected = ["youtube_shorts", "instagram_reels"] as const;
    const first = await acceptFlow(VIDEO_FLOW, "schedule_target", "2026-07-15T10:00:00.000Z", {
      selectedTargets: [...selected],
      target: "youtube_shorts",
    });
    expect(first?.next).toBe("schedule_target");
    const done = await acceptFlow(VIDEO_FLOW, "schedule_target", "2026-07-15T11:00:00.000Z", {
      ...first?.data,
      selectedTargets: [...selected],
      target: "instagram_reels",
    });
    expect(done?.next).toBe("schedule_confirm");
    const common = await acceptFlow(VIDEO_FLOW, "schedule_common", "2026-07-15T10:00:00.000Z", { selectedTargets: [...selected] });
    expect(common?.data.schedule).toEqual({
      youtube_shorts: "2026-07-15T10:00:00.000Z",
      instagram_reels: "2026-07-15T10:00:00.000Z",
    });
  });
});
