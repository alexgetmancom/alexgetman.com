import { describe, expect, it } from "bun:test";
import { publicationAction, publicationActionNames, publicationActions } from "../src/bot/publication-actions.js";
import { parsePublicationCallback, publicationCallback } from "../src/bot/publication-callback.js";

describe("Telegram publication callback registry", () => {
  it("declares one route for every publication action", () => {
    for (const kind of ["post", "video"] as const) {
      const names = publicationActionNames(kind);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(publicationAction(kind, name)).toBeDefined();
    }
  });

  it("parses callback arguments by the declaration order", () => {
    const callback = parsePublicationCallback(publicationCallback("post", "toggle", [42, "telegram"]));
    expect(callback).toEqual({ kind: "post", action: "toggle", args: ["42", "telegram"] });
    expect(publicationActions.post.toggle.args).toEqual(["target"]);
  });

  it("keeps generated callback data under Telegram's 64-byte limit", () => {
    const callbacks = [
      publicationCallback("post", "view", [123456789, "schedule_ru_evening"]),
      publicationCallback("post", "retry", [123456789, "instagram_reels", "notice"]),
      publicationCallback("video", "edit_field", [123456789, "instagram_caption"]),
      publicationCallback("video", "sched_pick", [123456789, "instagram_reels", "2200"], 999),
    ];
    expect(Math.max(...callbacks.map((callback) => callback.length))).toBeLessThanOrEqual(64);
  });
});
