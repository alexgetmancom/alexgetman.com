import { describe, expect, it } from "bun:test";
import { operationInput, parseArguments } from "../src/operations/cli-args.js";

function input(line: string): Record<string, unknown> {
  const argv = line.split(" ");
  return operationInput(argv[0] as string, parseArguments(argv));
}

describe("operations CLI arguments", () => {
  it("reads a value written with an equals sign", () => {
    expect(input("recent --limit=3")).toEqual({ limit: "3" });
  });

  it("arms a boolean written as --flag=true and leaves --flag=false unarmed", () => {
    expect(input("x-relink --apply=true")).toEqual({ apply: true });
    expect(input("x-relink --apply=false")).toEqual({});
    expect(input("x-relink --apply")).toEqual({ apply: true });
  });

  it("rejects an option no operation schema defines", () => {
    // The typo this guards: --ref instead of --refs took the backfill from one
    // publication to every target in the default set.
    expect(() => input("metrics-backfill --ref post:165 --apply")).toThrow(/unknown option --ref/);
    expect(() => input("recent --limitt 3")).toThrow(/unknown option --limitt/);
  });

  it("keeps the dispatcher's own options out of the operation input", () => {
    expect(input("recent --limit 3 --json")).toEqual({ limit: "3" });
  });

  it("collects a repeated option and keeps the last single value", () => {
    expect(input("channel-connect --platform youtube --locale en --credential a=1 --credential b=2")).toEqual({
      platform: "youtube",
      locale: "en",
      credential: ["a=1", "b=2"],
    });
  });
});
