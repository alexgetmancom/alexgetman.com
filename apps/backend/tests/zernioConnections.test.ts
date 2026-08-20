import { describe, expect, it } from "bun:test";
import { zernioConnectionOptions } from "../src/channels/zernio-connections.js";

describe("Zernio publication connections", () => {
  it("offers the routes the provider delivery adapters actually support", () => {
    expect(zernioConnectionOptions({ _id: "threads-1", platform: "Threads", username: "writer" }, "ru")).toMatchObject([
      { key: "threads", input: { targetId: "threads_ru", provider: "zernio", providerAccountId: "threads-1" } },
    ]);
    expect(zernioConnectionOptions({ _id: "instagram-1", platform: "Instagram", username: "creator" }, "en")).toMatchObject([
      { key: "instagram_reels", input: { platform: "instagram", provider: "zernio", providerAccountId: "instagram-1" } },
      {
        key: "instagram_stories",
        input: { targetId: "instagram_stories", provider: "zernio", providerAccountId: "instagram-1" },
      },
    ]);
  });

  it("does not offer analytics-only TikTok or unsupported Zernio YouTube publishing", () => {
    expect(zernioConnectionOptions({ _id: "tiktok-1", platform: "TikTok" }, "ru")).toEqual([]);
    expect(zernioConnectionOptions({ _id: "youtube-1", platform: "YouTube" }, "ru")).toEqual([]);
  });
});
