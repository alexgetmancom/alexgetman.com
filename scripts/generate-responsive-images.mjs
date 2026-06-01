import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const habrDir = path.join(root, 'public', 'habr-images');
const publicDir = path.join(root, 'public');
const widths = [360, 640, 960];
const youtubeChannelFeed = 'https://www.youtube.com/feeds/videos.xml?channel_id=UCMFl8-kqE8n9cyErKFSbPuQ';
const fallbackYoutubeId = 'e-RHZvID8q8';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function needsUpdate(inputPath, outputPath) {
  try {
    const [inputStat, outputStat] = await Promise.all([
      fs.stat(inputPath),
      fs.stat(outputPath),
    ]);
    return outputStat.mtimeMs < inputStat.mtimeMs;
  } catch {
    return true;
  }
}

async function generateHabrImages() {
  if (!(await exists(habrDir))) {
    return;
  }

  const files = await fs.readdir(habrDir);
  for (const file of files) {
    if (!/\.(jpe?g|png)$/i.test(file)) {
      continue;
    }

    const inputPath = path.join(habrDir, file);
    const parsed = path.parse(file);
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    const sourceWidth = metadata.width || 0;

    for (const width of widths) {
      if (sourceWidth && width > sourceWidth) {
        continue;
      }
      const outputPath = path.join(habrDir, `${parsed.name}-${width}.webp`);
      if (!(await needsUpdate(inputPath, outputPath))) {
        continue;
      }
      await sharp(inputPath)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 74, effort: 6 })
        .toFile(outputPath);
    }
  }
}

async function generateAvatar() {
  const inputPath = path.join(publicDir, 'avatar-small.png');
  if (!(await exists(inputPath))) {
    return;
  }

  const outputPath = path.join(publicDir, 'avatar-small.webp');
  if (!(await needsUpdate(inputPath, outputPath))) {
    return;
  }

  await sharp(inputPath)
    .resize({ width: 72, height: 72, fit: 'cover' })
    .webp({ quality: 76, effort: 6 })
    .toFile(outputPath);
}

async function getLatestCompletedYoutubeId() {
  try {
    const response = await fetch(youtubeChannelFeed);
    if (!response.ok) {
      return fallbackYoutubeId;
    }

    const xmlText = await response.text();
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let match;

    while ((match = entryRegex.exec(xmlText)) !== null) {
      const entryContent = match[1];
      const idMatch = entryContent.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
      const titleMatch = entryContent.match(/<title>([^<]+)<\/title>/);
      if (!idMatch || !titleMatch) {
        continue;
      }

      const title = titleMatch[1].trim().toLowerCase();
      if (
        title.includes('ожидаем') ||
        title.includes('ожидани') ||
        title.includes('waiting') ||
        title.includes('upcoming')
      ) {
        continue;
      }

      return idMatch[1].trim();
    }
  } catch {
    return fallbackYoutubeId;
  }

  return fallbackYoutubeId;
}

async function generateStreamCover() {
  const videoId = await getLatestCompletedYoutubeId();
  const outputPath = path.join(publicDir, `stream-cover-${videoId}.webp`);
  if (await exists(outputPath)) {
    return;
  }

  const response = await fetch(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
  if (!response.ok) {
    return;
  }

  const source = Buffer.from(await response.arrayBuffer());
  await sharp(source)
    .resize({ width: 640, withoutEnlargement: true })
    .webp({ quality: 76, effort: 6 })
    .toFile(outputPath);
}

await generateHabrImages();
await generateAvatar();
await generateStreamCover();
