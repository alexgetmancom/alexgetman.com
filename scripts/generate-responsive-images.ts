import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { RESPONSIVE_WIDTHS } from "../apps/backend/src/content/site-media-naming.ts";

const root = process.cwd();
const webRoot = path.join(root, "apps", "web");
const publicDir = path.join(webRoot, "public");
const cacheFile = path.join(webRoot, ".image-cache.json");

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

let cache: Record<string, number> = {};
if (await exists(cacheFile)) {
  cache = (await readJson<Record<string, number>>(cacheFile)) || {};
}

const usedCacheKeys = new Set<string>();

async function saveCache(): Promise<void> {
  for (const key of Object.keys(cache)) {
    if (!usedCacheKeys.has(key)) delete cache[key];
  }
  try {
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    console.warn("Failed to save image cache:", error);
  }
}

/** Reports whether `inputPath` changed since the last successful run. Does not
 * commit — call commitCache after the corresponding output is written, so a
 * failed generation is retried on the next run instead of being skipped. */
async function needsUpdate(inputPath: string, key: string): Promise<boolean> {
  usedCacheKeys.add(key);
  try {
    const stat = await fs.stat(inputPath);
    return cache[key] !== stat.mtimeMs;
  } catch {
    return true;
  }
}

async function commitCache(inputPath: string, key: string): Promise<void> {
  try {
    cache[key] = (await fs.stat(inputPath)).mtimeMs;
  } catch {
    // Input disappeared between generation and commit; leave the cache key
    // absent so the next run retries it.
  }
}

async function resolvePublicImage(publicPath: string | null | undefined): Promise<string | null> {
  const normalized = String(publicPath || "").replace(/^\/+/, "");
  if (!normalized) return null;
  const candidate = path.join(publicDir, normalized);
  return (await exists(candidate)) ? candidate : null;
}

async function generateAvatar() {
  const inputPath = path.join(publicDir, "avatar-small.png");
  if (!(await exists(inputPath))) return;

  if (!(await needsUpdate(inputPath, "avatar-small"))) return;

  await sharp(inputPath)
    .resize({ width: 72, height: 72, fit: "cover" })
    .webp({ quality: 76, effort: 6 })
    .toFile(path.join(publicDir, "avatar-small.webp"));
  await commitCache(inputPath, "avatar-small");
}

async function generateSocialImage() {
  const inputPath = path.join(publicDir, "avatar.png");
  if (!(await exists(inputPath))) return;

  if (!(await needsUpdate(inputPath, "avatar"))) return;

  await sharp(inputPath)
    .resize({ width: 500, height: 500, fit: "cover" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(publicDir, "social-image.jpg"));
  await commitCache(inputPath, "avatar");
}

function responsiveOutputName(publicPath: string, width: number): string {
  return String(publicPath)
    .replace(/^\/+/, "")
    .replace(/[\\/]/g, "-")
    .replace(/\.[a-z0-9]+$/i, `-${width}.webp`);
}

async function collectImages(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const images: string[] = [];
  for (const entry of entries) {
    const publicPath = path.join(prefix, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (["generated", "og", ".well-known"].includes(entry.name)) continue;
      images.push(...(await collectImages(path.join(dir, entry.name), publicPath)));
    } else if (/\.(png|jpe?g)$/i.test(entry.name)) {
      if (/^(avatar|social-image|favicon)/.test(publicPath)) continue;
      images.push(publicPath);
    }
  }
  return images;
}

async function generateResponsiveImages() {
  const outputDir = path.join(publicDir, "generated/responsive");
  await fs.mkdir(outputDir, { recursive: true });
  const images = new Set(await collectImages(publicDir));

  for (const publicPath of images) {
    const inputPath = await resolvePublicImage(publicPath);
    if (!inputPath) continue;
    const key = `responsive:${publicPath}`;
    const updated = await needsUpdate(inputPath, key);
    const outputs = RESPONSIVE_WIDTHS.map((width) => ({
      width,
      outputPath: path.join(outputDir, responsiveOutputName(publicPath, width)),
    }));
    // Reading metadata costs an open+header parse per image. Only do it once we
    // know at least one variant actually has to be produced, so an unchanged
    // run touches nothing but the cache and the output stat calls.
    const pending = [];
    for (const output of outputs) if (updated || !(await exists(output.outputPath))) pending.push(output);
    if (!pending.length) continue;
    if (!(await sharp(inputPath).metadata()).width) continue;

    let allOk = true;
    for (const { width, outputPath } of pending) {
      try {
        await sharp(inputPath).resize({ width, withoutEnlargement: true }).webp({ quality: 78, effort: 5 }).toFile(outputPath);
      } catch (error) {
        allOk = false;
        console.warn(`Failed to generate ${outputPath}:`, error);
      }
    }
    if (allOk) await commitCache(inputPath, key);
  }
}

await generateAvatar();
await generateSocialImage();
await generateResponsiveImages();
await saveCache();
