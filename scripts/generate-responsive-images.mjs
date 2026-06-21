import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const cacheFile = path.join(root, '.image-cache.json');
const widths = [360, 640, 960];

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Load cache
let cache = {};
if (await exists(cacheFile)) {
  try {
    cache = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
  } catch {}
}

async function saveCache() {
  try {
    await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
  } catch {}
}

async function needsUpdate(inputPath, key) {
  try {
    const stat = await fs.stat(inputPath);
    const mtime = stat.mtimeMs;
    if (cache[key] === mtime) {
      return false; // File has not changed
    }
    cache[key] = mtime;
    return true;
  } catch {
    return true;
  }
}

async function generateAvatar() {
  const inputPath = path.join(publicDir, 'avatar-small.png');
  if (!(await exists(inputPath))) {
    return;
  }

  const key = 'avatar-small';
  const updated = await needsUpdate(inputPath, key);
  if (!updated) {
    return;
  }

  const outputPath = path.join(publicDir, 'avatar-small.webp');
  await sharp(inputPath)
    .resize({ width: 72, height: 72, fit: 'cover' })
    .webp({ quality: 76, effort: 6 })
    .toFile(outputPath);
}

async function generateSocialImage() {
  const inputPath = path.join(publicDir, 'avatar.png');
  if (!(await exists(inputPath))) {
    return;
  }

  const key = 'avatar';
  const updated = await needsUpdate(inputPath, key);
  if (!updated) {
    return;
  }

  const outputPath = path.join(publicDir, 'social-image.jpg');
  await sharp(inputPath)
    .resize({ width: 500, height: 500, fit: 'cover' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(outputPath);
}

await generateAvatar();
await generateSocialImage();
await saveCache();
