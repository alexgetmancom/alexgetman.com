import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as z from "zod";
import { STORY_CARD_HEIGHT, STORY_CARD_WIDTH, storyCardOverlaySvg } from "./svg.js";

const inputSchema = z.object({
  backgroundPath: z.string().min(1),
  outputPath: z.string().min(1),
  copy: z.object({
    headline: z.string(),
    emoji: z.string().nullable(),
    lines: z.array(z.string()).min(1).max(6),
    boldLineCount: z.number().int().min(0).max(6),
    templateVersion: z.literal("strata-v1"),
  }),
});

const input = inputSchema.parse(JSON.parse(await Bun.stdin.text()));
await mkdir(path.dirname(input.outputPath), { recursive: true });
const { default: sharp } = await import("sharp");
sharp.cache(false);
sharp.concurrency(1);
const result = await sharp(input.backgroundPath)
  .resize(STORY_CARD_WIDTH, STORY_CARD_HEIGHT, { fit: "cover" })
  .composite([{ input: Buffer.from(storyCardOverlaySvg(input.copy)) }])
  .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
  .toFile(input.outputPath);
process.stdout.write(JSON.stringify({ outputPath: input.outputPath, bytes: result.size }));
