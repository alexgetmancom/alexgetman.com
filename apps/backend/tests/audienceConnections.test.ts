import { describe, expect, it } from "bun:test";
import { audienceGroup, uniqueAudienceConnections } from "../src/analytics/audience-groups.js";

describe("audience connection identity", () => {
  it("classifies both Instagram Story languages as text audiences", () => {
    expect(audienceGroup("instagram_stories")).toBe("text");
    expect(audienceGroup("instagram_stories_ru")).toBe("text");
  });

  it("counts one provider account once across Reels and Stories", () => {
    const connections = uniqueAudienceConnections([
      {
        id: "instagram_stories_ru",
        platform: "instagram_stories_ru",
        provider: "zernio",
        providerAccountId: "account-1",
        targetId: "instagram_stories_ru",
      },
      {
        id: "instagram_ru",
        platform: "instagram",
        provider: "zernio",
        providerAccountId: "account-1",
        targetId: null,
      },
    ]);

    expect(connections.map(({ id }) => id)).toEqual(["instagram_ru"]);
  });
});
