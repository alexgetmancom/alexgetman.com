import { describe, expect, it } from "bun:test";
import {
  legacyToPublication,
  parseDraftId,
  parsePublicationCallback,
  parseSessionCallback,
  publicationCallback,
  versionedCallback,
} from "../src/bot/session-fsm.js";

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
      args: ["7", "0800"],
    });
    expect(parseSessionCallback(encoded)).toEqual({ data: "p:video:sched_pick:0800:7", revision: 4 });
  });

  it("leaves the canonical namespace intact while legacy translation normalizes old payloads", () => {
    expect(parseSessionCallback("p:post:sched_scope:both:42")).toEqual({ data: "p:post:sched_scope:both:42", revision: null });
    expect(legacyToPublication("video_now:12")).toEqual({ kind: "video", action: "now", args: ["12"] });
    expect(parsePublicationCallback("p:video:now:12")).toEqual({ kind: "video", action: "now", args: ["12"] });
  });

  it("accepts only positive safe draft identifiers", () => {
    expect(parseDraftId("1")).toBe(1);
    expect(parseDraftId("0")).toBeNull();
    expect(parseDraftId("-1")).toBeNull();
    expect(parseDraftId("9007199254740992")).toBeNull();
  });
});
