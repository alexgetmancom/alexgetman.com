import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { centeredScrollPosition, easeOutCubic, railScrollTarget } from "./rail-geometry";

function layout<T extends object>(
  element: T,
  values: Partial<
    Record<
      "clientHeight" | "clientWidth" | "scrollHeight" | "scrollWidth" | "offsetHeight" | "offsetLeft" | "offsetTop" | "offsetWidth",
      number
    >
  >,
): T {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(element, key, { configurable: true, value });
  return element;
}

describe("story rail geometry", () => {
  it("centers a card and clamps it to the scrollable range", () => {
    expect(centeredScrollPosition(500, 100, 400, 1_000)).toBe(350);
    expect(centeredScrollPosition(10, 100, 400, 1_000)).toBe(0);
    expect(centeredScrollPosition(950, 100, 400, 1_000)).toBe(600);
  });

  it("reads mocked layout values from happy-dom without pretending it calculates CSS", () => {
    const window = new Window();
    const rail = layout(window.document.createElement("nav"), {
      clientWidth: 400,
      clientHeight: 500,
      scrollWidth: 1_200,
      scrollHeight: 2_000,
    });
    const card = layout(window.document.createElement("a"), { offsetLeft: 300, offsetTop: 800, offsetWidth: 100, offsetHeight: 100 });

    expect(railScrollTarget(rail, card)).toEqual({ left: 150, top: 600 });
  });

  it("keeps the easing curve bounded", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(0.5)).toBe(0.875);
    expect(easeOutCubic(1)).toBe(1);
  });
});
