import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { categorySlugFromBadge, getSmartBadge, categoryLabel as taxonomyLabel } from "../apps/web/src/utils/taxonomy.ts";

type FeedMediaItem = { type?: string; path?: string };
type FeedItem = {
  post_id?: number | string;
  has_en?: boolean;
  has_ru?: boolean;
  text?: string;
  text_en?: string;
  image?: string;
  image_en?: string;
  media?: FeedMediaItem[];
  media_en?: FeedMediaItem[];
};

const root = process.cwd();
const webRoot = path.join(root, "apps", "web");
const publicDir = path.join(webRoot, "public");
const publishedDir = process.env.PUBLISHED_DIR || "/home/deploy/ialexey-web";
const dataDir = process.env.DATA_DIR || "/home/deploy/ialexey-feed/data";
const feedJsonPaths = [path.join(dataDir, "feed.json"), path.join(webRoot, "src/data/feed.json")];
const cacheFile = path.join(webRoot, ".image-cache.json");
const widths = [360, 640, 960];

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

async function loadFeedItems(): Promise<FeedItem[]> {
  for (const filePath of feedJsonPaths) {
    if (!(await exists(filePath))) continue;
    const parsed = await readJson<FeedItem[] | { items?: FeedItem[] }>(filePath);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.items)) return parsed.items;
  }
  return [];
}

let cache: Record<string, number> = {};
if (await exists(cacheFile)) {
  cache = (await readJson<Record<string, number>>(cacheFile)) || {};
}

async function saveCache(): Promise<void> {
  try {
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf-8");
  } catch {}
}

async function needsUpdate(inputPath: string, key: string): Promise<boolean> {
  try {
    const stat = await fs.stat(inputPath);
    const mtime = stat.mtimeMs;
    if (cache[key] === mtime) {
      return false;
    }
    cache[key] = mtime;
    return true;
  } catch {
    return true;
  }
}

function compactText(value: unknown): string {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: unknown, limit: number): string {
  const text = compactText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function getFirstSentence(text: unknown): string {
  const value = String(text || "").trim();
  if (!value) return "";
  const newlineIdx = value.indexOf("\n");
  const match = value.match(/^.*?[.!?](?:\s|\n|$)/s);
  if (match) {
    if (newlineIdx !== -1 && newlineIdx < match[0].length) {
      return value.slice(0, newlineIdx).trim();
    }
    return match[0].trim();
  }
  if (newlineIdx !== -1) return value.slice(0, newlineIdx).trim();
  return value;
}

function escapeXml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function splitLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = compactText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = next;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
}

// Category badges are a single source (apps/web taxonomy) so the OG image badge
// always matches the badge rendered on the post page.
function categoryLabel(text: unknown, locale: string): string {
  return taxonomyLabel(categorySlugFromBadge(getSmartBadge(String(text ?? ""))), locale);
}

function normalizePublicPath(value: unknown): string {
  return String(value || "").replace(/^\/+/, "");
}

function postImagePath(item: FeedItem, locale: string): string {
  const localizedMedia = locale === "ru" ? item.media : item.media_en;
  const fallbackMedia = locale === "ru" ? item.media_en : item.media;
  const media =
    Array.isArray(localizedMedia) && localizedMedia.length > 0 ? localizedMedia : Array.isArray(fallbackMedia) ? fallbackMedia : [];
  const imageMedia = media.find((mediaItem) => mediaItem?.type !== "video" && mediaItem?.path);
  const directImage = locale === "ru" ? item.image || item.image_en : item.image_en || item.image;
  return normalizePublicPath(directImage || imageMedia?.path);
}

async function resolvePublicImage(publicPath: string | null | undefined): Promise<string | null> {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized) return null;
  const candidates = [path.join(publicDir, normalized), path.join(publishedDir, normalized)];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function generateAvatar() {
  const inputPath = path.join(publicDir, "avatar-small.png");
  if (!(await exists(inputPath))) return;

  const updated = await needsUpdate(inputPath, "avatar-small");
  if (!updated) return;

  await sharp(inputPath)
    .resize({ width: 72, height: 72, fit: "cover" })
    .webp({ quality: 76, effort: 6 })
    .toFile(path.join(publicDir, "avatar-small.webp"));
}

async function generateSocialImage() {
  const inputPath = path.join(publicDir, "avatar.png");
  if (!(await exists(inputPath))) return;

  const updated = await needsUpdate(inputPath, "avatar");
  if (!updated) return;

  await sharp(inputPath)
    .resize({ width: 500, height: 500, fit: "cover" })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(publicDir, "social-image.jpg"));
}

async function generatePostOgImages(feedItems: FeedItem[]): Promise<void> {
  const outputDir = path.join(publicDir, "og/posts");
  await fs.mkdir(outputDir, { recursive: true });
  const avatarPath = (await resolvePublicImage("avatar-small.png")) || (await resolvePublicImage("avatar.png"));
  const avatarDataUri = avatarPath
    ? `data:image/png;base64,${(
        await sharp(avatarPath)
          .resize({ width: 160, height: 160, fit: "cover" })
          .composite([
            {
              input: Buffer.from('<svg width="160" height="160"><circle cx="80" cy="80" r="80" fill="white"/></svg>'),
              blend: "dest-in",
            },
          ])
          .png()
          .toBuffer()
      ).toString("base64")}`
    : "";

  for (const item of feedItems) {
    const postId = item?.post_id;
    if (!postId) continue;

    const variants = [
      { locale: "en", enabled: item.has_en && item.text_en, text: item.text_en, image: postImagePath(item, "en") },
      { locale: "ru", enabled: item.has_ru && item.text, text: item.text, image: postImagePath(item, "ru") },
    ];

    for (const variant of variants) {
      if (!variant.enabled) continue;
      const title = truncateText(getFirstSentence(variant.text) || `Post ${postId}`, 132);
      const sourceImage = await resolvePublicImage(variant.image);
      const lines = splitLines(title, variant.locale === "ru" ? 25 : 28, sourceImage ? 3 : 4);
      const badge = categoryLabel(variant.text, variant.locale);
      const sourceImageStamp = sourceImage ? (await fs.stat(sourceImage)).mtimeMs : "none";
      const key = `og:v5:${postId}:${variant.locale}:${compactText(title)}:${badge}:${sourceImageStamp}:${Boolean(avatarDataUri)}`;
      const outputPath = path.join(outputDir, `post-${postId}-${variant.locale}.jpg`);

      if (cache[key] && (await exists(outputPath))) continue;
      cache[key] = Date.now();

      const lineSvg = lines
        .map(
          (line, index) => `<text x="74" y="${sourceImage ? 340 + index * 72 : 255 + index * 76}" class="title">${escapeXml(line)}</text>`,
        )
        .join("");

      const svg = sourceImage
        ? `
        <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
          <rect width="1200" height="630" fill="url(#corner)"/>
          <g transform="translate(812 468)">
            <text x="248" y="43" class="brand">alex</text>
            <text x="248" y="99" class="brand">getman</text>
            ${avatarDataUri ? `<image href="${avatarDataUri}" x="276" y="0" width="104" height="104"/>` : '<circle cx="328" cy="52" r="52" fill="#F04465"/>'}
          </g>
          <defs>
            <radialGradient id="corner" cx="100%" cy="100%" r="58%">
              <stop offset="0%" stop-color="rgba(0,0,0,0.68)"/>
              <stop offset="48%" stop-color="rgba(0,0,0,0.20)"/>
              <stop offset="100%" stop-color="rgba(0,0,0,0)"/>
            </radialGradient>
          </defs>
          <style>
            .brand{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;fill:white;font-size:52px;font-weight:900;letter-spacing:0;text-anchor:end;filter:drop-shadow(0 4px 16px rgba(0,0,0,.88))}
          </style>
        </svg>
      `
        : `
        <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
          <rect width="1200" height="630" fill="#080B10"/>
          <rect x="0" y="0" width="1200" height="630" fill="url(#grid)" opacity="0.28"/>
          <text x="74" y="90" class="site">alexgetman.com</text>
          <text x="74" y="174" class="badge">${escapeXml(badge)}</text>
          ${lineSvg}
          <g transform="translate(74 520)">
            ${avatarDataUri ? `<image href="${avatarDataUri}" x="0" y="-34" width="68" height="68"/>` : '<circle cx="34" cy="0" r="34" fill="#F04465"/>'}
            <text x="86" y="-8" class="author">alex</text>
            <text x="86" y="26" class="post">getman</text>
          </g>
          <defs>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#202635" stroke-width="1"/>
            </pattern>
          </defs>
          <style>
            .site,.badge,.title,.author,.post{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;letter-spacing:0}
            .site{fill:#A3ADBC;font-size:28px}
            .badge{fill:#F04465;font-size:30px}
            .title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:58px;font-weight:850;fill:#F3F6FA;letter-spacing:0}
            .author{fill:#F3F6FA;font-size:30px;font-weight:850}
            .post{fill:#A3ADBC;font-size:30px;font-weight:850}
          </style>
        </svg>
      `;

      const base = sourceImage
        ? await sharp(sourceImage)
            .resize({ width: 1200, height: 630, fit: "cover" })
            .modulate({ brightness: 0.98, saturation: 1.0 })
            .jpeg({ quality: 92, mozjpeg: true })
            .toBuffer()
        : await sharp({
            create: { width: 1200, height: 630, channels: 3, background: "#080B10" },
          })
            .jpeg()
            .toBuffer();

      await sharp(base)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 84, mozjpeg: true })
        .toFile(outputPath);
    }
  }
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
  for (const item of await loadFeedItems()) {
    for (const locale of ["en", "ru"]) {
      const image = postImagePath(item, locale);
      if (image && /\.(png|jpe?g)$/i.test(image)) images.add(image);
    }
  }

  for (const publicPath of images) {
    const inputPath = await resolvePublicImage(publicPath);
    if (!inputPath) continue;
    const updated = await needsUpdate(inputPath, `responsive:${publicPath}`);
    const metadata = await sharp(inputPath).metadata();
    if (!metadata.width) continue;

    for (const width of widths) {
      const outputPath = path.join(outputDir, responsiveOutputName(publicPath, width));
      if (!updated && (await exists(outputPath))) continue;
      await sharp(inputPath).resize({ width, withoutEnlargement: true }).webp({ quality: 78, effort: 5 }).toFile(outputPath);
    }
  }
}

const feedItems = await loadFeedItems();
await generateAvatar();
await generateSocialImage();
await generatePostOgImages(feedItems);
await generateResponsiveImages();
await saveCache();
