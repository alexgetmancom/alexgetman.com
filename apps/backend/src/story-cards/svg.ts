import type { StoryCardCopy } from "./copy.js";

export const STORY_CARD_WIDTH = 1080;
export const STORY_CARD_HEIGHT = 1920;
export const STORY_CARD_EMOJI_LEFT = 108;
export const STORY_CARD_EMOJI_SIZE = 58;

export function storyCardFirstBaseline(copy: StoryCardCopy): number {
  const fontSize = 74;
  const lineHeight = 94;
  return 1020 - ((copy.lines.length - 1) * lineHeight) / 2 + fontSize * 0.25;
}

export function storyCardOverlaySvg(copy: StoryCardCopy): string {
  const fontSize = 74;
  const lineHeight = 94;
  const firstBaseline = storyCardFirstBaseline(copy);
  const text = copy.lines
    .map(
      (line, index) =>
        `<text x="190" y="${firstBaseline + index * lineHeight}" class="copy" font-weight="${
          index < copy.boldLineCount ? 680 : 440
        }">${escapeXml(line)}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${STORY_CARD_WIDTH}" height="${STORY_CARD_HEIGHT}">
  <defs>
    <filter id="glow" x="-15%" y="-25%" width="130%" height="150%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="3.2" result="blur"/>
      <feFlood flood-color="#f0d19a" flood-opacity=".18" result="warm"/>
      <feComposite in="warm" in2="blur" operator="in" result="halo"/>
      <feMerge><feMergeNode in="halo"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      text { font-family: Manrope, sans-serif; fill: #f3eee4; }
      .copy { font-size: ${fontSize}px; letter-spacing: -1.15px; }
    </style>
  </defs>
  <text x="540" y="150" text-anchor="middle" font-size="29" font-weight="430"
        letter-spacing="10" fill-opacity=".8" filter="url(#glow)">alex getman</text>
  <g filter="url(#glow)">${text}</g>
</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;";
    if (character === "<") return "&lt;";
    if (character === ">") return "&gt;";
    if (character === '"') return "&quot;";
    return "&apos;";
  });
}
