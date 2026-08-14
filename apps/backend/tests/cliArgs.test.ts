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
    expect(input("x-relink --apply=false")).toEqual({ apply: false });
    expect(input("x-relink --apply")).toEqual({ apply: true });
  });

  it("refuses a value written after a boolean flag", () => {
    // `--apply true` parked "true" in the values map, where a boolean field
    // never looks: the mutation stayed unarmed and the run still reported ok.
    expect(() => input("x-relink --apply true")).toThrow(/--apply is a flag/);
    expect(() => input("purge --ref post:1 --apply yes")).toThrow(/--apply is a flag/);
  });

  it("hands an option no schema defines to the registry, which names it", () => {
    // The typo this guards: --ref instead of --refs took the backfill from one
    // publication to every target in the default set. One rejection, in the one
    // place both surfaces validate through.
    expect(input("metrics-backfill --ref post:165 --apply")).toEqual({ ref: "post:165", apply: true });
    expect(() => input("recent --limitt")).not.toThrow();
    expect(input("recent --limitt 3")).toEqual({ limitt: "3" });
  });

  it("refuses a bare argument and an option left without its value", () => {
    // `recent 10` reported five posts and said nothing about the 10.
    expect(() => input("recent 10")).toThrow(/unexpected argument "10"/);
    expect(() => input("verify --ref")).toThrow(/--ref needs a value/);
  });

  it("keeps the dispatcher's own options out of the operation input", () => {
    expect(input("recent --limit 3 --json")).toEqual({ limit: "3" });
  });

  it("keeps the last value when an option is repeated", () => {
    expect(input("channel-connect --platform youtube --platform instagram --locale en")).toEqual({
      platform: "instagram",
      locale: "en",
    });
  });
});
