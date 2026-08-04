import { describe, expect, it } from "bun:test";
import { parsePublicationCallback, parseSessionCallback, publicationCallback, versionedCallback } from "../src/bot/session-fsm.js";

describe("Telegram session callback encoding", () => {
  it("uses a prefix so a future data segment cannot look like a revision suffix", () => {
    const encoded = versionedCallback("action:sv42", 7);
    expect(encoded).toBe("sv7|action:sv42");
    expect(parseSessionCallback(encoded)).toEqual({ data: "action:sv42", revision: 7 });
  });

  it("continues accepting callbacks emitted before the prefix format", () => {
    expect(parseSessionCallback("action:7:sv3")).toEqual({ data: "action:7", revision: 3 });
  });

  it("writes publication controls in one namespace and reads them back as legacy handler data", () => {
    const encoded = publicationCallback("video", "sched_pick", ["0800", 7], 4);
    expect(encoded).toBe("sv4|p:video:sched_pick:0800:7");
    expect(parsePublicationCallback("p:video:sched_pick:0800:7")).toEqual({
      kind: "video",
      action: "sched_pick",
      args: ["0800", "7"],
    });
    expect(parseSessionCallback(encoded)).toEqual({ data: "video_sched_pick:0800:7", revision: 4 });
  });

  it("normalizes an unversioned canonical post callback for the existing router", () => {
    expect(parseSessionCallback("p:post:sched_scope:both:42")).toEqual({ data: "sched_scope:both:42", revision: null });
  });
});
