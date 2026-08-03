export type RailLayoutNode = {
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
};
export type RailCardLayout = {
  offsetHeight: number;
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
};

export function centeredScrollPosition(start: number, size: number, viewport: number, scrollable: number): number {
  const centered = start - (viewport - size) / 2;
  return Math.min(Math.max(0, centered), Math.max(0, scrollable - viewport));
}

export function railScrollTarget(rail: RailLayoutNode, card: RailCardLayout): { left: number; top: number } {
  return {
    left: centeredScrollPosition(card.offsetLeft, card.offsetWidth, rail.clientWidth, rail.scrollWidth),
    top: centeredScrollPosition(card.offsetTop, card.offsetHeight, rail.clientHeight, rail.scrollHeight),
  };
}

export function easeOutCubic(progress: number): number {
  return 1 - (1 - progress) ** 3;
}
