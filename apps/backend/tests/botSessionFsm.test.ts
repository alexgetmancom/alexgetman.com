import { describe, expect, it } from "bun:test";
import { parseSessionCallback, versionedCallback } from "../src/bot/session-fsm.js";

describe("Telegram session callback encoding", () => {
  it("uses a prefix so a future data segment cannot look like a revision suffix", () => {
    const encoded = versionedCallback("action:sv42", 7);
    expect(encoded).toBe("sv7|action:sv42");
    expect(parseSessionCallback(encoded)).toEqual({ data: "action:sv42", revision: 7 });
  });

  it("continues accepting callbacks emitted before the prefix format", () => {
    expect(parseSessionCallback("action:7:sv3")).toEqual({ data: "action:7", revision: 3 });
  });
});
