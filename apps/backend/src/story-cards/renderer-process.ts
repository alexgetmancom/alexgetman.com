import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OverlayOptions } from "sharp";
import * as z from "zod";
import {
  STORY_CARD_EMOJI_LEFT,
  STORY_CARD_EMOJI_SIZE,
  STORY_CARD_HEIGHT,
  STORY_CARD_WIDTH,
  storyCardFirstBaseline,
  storyCardOverlaySvg,
} from "./svg.js";

const inputSchema = z.object({
  backgroundPath: z.string().min(1),
  assetsDir: z.string().min(1),
  outputPath: z.string().min(1),
  copy: z.object({
    headline: z.string(),
    emoji: z.string().nullable(),
    lines: z.array(z.string()).min(1).max(6),
    boldLineCount: z.number().int().min(0).max(6),
    templateVersion: z.literal("strata-v2"),
  }),
});

const input = inputSchema.parse(JSON.parse(await Bun.stdin.text()));
await mkdir(path.dirname(input.outputPath), { recursive: true });
const { default: sharp } = await import("sharp");
sharp.cache(false);
sharp.concurrency(1);
const composites: OverlayOptions[] = [{ input: Buffer.from(storyCardOverlaySvg(input.copy)) }];
const emojiFile = emojiAssetFile(input.copy.emoji);
if (emojiFile) {
  composites.push({
    input: await sharp(path.join(input.assetsDir, "emoji", emojiFile))
      .resize(STORY_CARD_EMOJI_SIZE, STORY_CARD_EMOJI_SIZE, { fit: "contain" })
      .png()
      .toBuffer(),
    left: STORY_CARD_EMOJI_LEFT,
    top: Math.round(storyCardFirstBaseline(input.copy) - STORY_CARD_EMOJI_SIZE + 7),
  });
}
const result = await sharp(input.backgroundPath)
  .resize(STORY_CARD_WIDTH, STORY_CARD_HEIGHT, { fit: "cover" })
  .composite(composites)
  .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
  .toFile(input.outputPath);
process.stdout.write(JSON.stringify({ outputPath: input.outputPath, bytes: result.size }));

function emojiAssetFile(emoji: string | null): string | null {
  if (emoji === "🚨") return "1f6a8.svg";
  if (emoji === "⚡" || emoji === "⚡️") return "26a1.svg";
  if (emoji === "🔴") return "1f534.svg";
  return null;
}
