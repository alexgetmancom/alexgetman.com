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
    expect(parseSessionCallback(encoded)).toEqual({ data: "action:sv42", callback: null, revision: 7 });
  });

  it("leaves an unversioned callback without a revision", () => {
    expect(parseSessionCallback("action:7:sv3")).toEqual({ data: "action:7:sv3", callback: null, revision: null });
  });

  it("round-trips canonical publication arguments without guessing their meaning", () => {
    for (const draftId of [7, 999, 1000, 9999, 10000]) {
      const args = [String(draftId), "0800"];
      const encoded = publicationCallback("video", "sched_pick", args, 4);
      expect(encoded).toBe(`sv4|p:video:sched_pick:${draftId}:0800`);
      expect(parsePublicationCallback(`p:video:sched_pick:${draftId}:0800`)).toEqual({
        kind: "video",
        action: "sched_pick",
        args,
      });
    }
    expect(parsePublicationCallback("p:video:sched_pick:0800:7")).toEqual({
      kind: "video",
      action: "sched_pick",
      args: ["0800", "7"],
    });
  });

  it("parses canonical and legacy publication callbacks into one object shape", () => {
    expect(parseSessionCallback("p:post:sched_scope:both:42")).toEqual({
      data: "p:post:sched_scope:both:42",
      callback: { kind: "post", action: "sched_scope", args: ["both", "42"] },
      revision: null,
    });
    expect(legacyToPublication("video_now:12")).toEqual({ kind: "video", action: "now", args: ["12"] });
    expect(parseSessionCallback("video_now:12").callback).toEqual({ kind: "video", action: "now", args: ["12"] });
    expect(legacyToPublication("sched_scope:both:42")).toEqual({
      kind: "post",
      action: "sched_scope",
      args: ["42", "both"],
    });
    expect(legacyToPublication("sched_pick:ru:0830:42")).toEqual({
      kind: "post",
      action: "sched_pick",
      args: ["42", "ru", "0830"],
    });
    expect(legacyToPublication("video_retry:youtube_shorts:12")).toEqual({
      kind: "video",
      action: "retry",
      args: ["12", "youtube_shorts"],
    });
    expect(legacyToPublication("video_sched_pick:0800:7")).toEqual({
      kind: "video",
      action: "sched_pick",
      args: ["7", "0800"],
    });
    expect(legacyToPublication("video_edit_field:youtube_title:7")).toEqual({
      kind: "video",
      action: "edit_field",
      args: ["7", "youtube_title"],
    });
    expect(parsePublicationCallback("video_now:12")).toBeNull();
    expect(parsePublicationCallback("p:video:now:12")).toEqual({ kind: "video", action: "now", args: ["12"] });
  });

  it("accepts only positive safe draft identifiers", () => {
    expect(parseDraftId("1")).toBe(1);
    expect(parseDraftId("0")).toBeNull();
    expect(parseDraftId("-1")).toBeNull();
    expect(parseDraftId("9007199254740992")).toBeNull();
  });
});
