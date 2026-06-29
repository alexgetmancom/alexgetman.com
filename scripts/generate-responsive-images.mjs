import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const publicDir = path.join(root, 'public');
const publishedDir = process.env.PUBLISHED_DIR || '/home/deploy/ialexey-web';
const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
const feedJsonPaths = [
  path.join(dataDir, 'feed.json'),
  path.join(root, 'src/data/feed.json'),
];
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

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

async function loadFeedItems() {
  for (const filePath of feedJsonPaths) {
    if (!(await exists(filePath))) continue;
    const parsed = await readJson(filePath);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.items)) return parsed.items;
  }
  return [];
}

let cache = {};
if (await exists(cacheFile)) {
  cache = (await readJson(cacheFile)) || {};
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
      return false;
    }
    cache[key] = mtime;
    return true;
  } catch {
    return true;
  }
}

function compactText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateText(value, limit) {
  const text = compactText(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
}

function getFirstSentence(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const newlineIdx = value.indexOf('\n');
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

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function splitLines(text, maxChars, maxLines) {
  const words = compactText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
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

function categoryLabel(text, locale) {
  const t = String(text || '').toLowerCase();
  if (t.includes('gpt') || t.includes('gemini') || t.includes('claude') || t.includes('anthropic') || t.includes('openai') || t.includes('google') || t.includes('llama') || t.includes('codex')) {
    return locale === 'ru' ? 'ИИ-Модели' : 'AI Models';
  }
  if (t.includes('нейросеть') || t.includes('midjourney') || t.includes('sora') || t.includes('генераци') || t.includes('ai ')) {
    return locale === 'ru' ? 'Нейросети' : 'Neural Networks';
  }
  if (t.includes('слив') || t.includes('leak')) {
    return locale === 'ru' ? 'Сливы' : 'Leaks';
  }
  return locale === 'ru' ? 'Новости' : 'News';
}

function normalizePublicPath(value) {
  return String(value || '').replace(/^\/+/, '');
}

function postImagePath(item, locale) {
  const localizedMedia = locale === 'ru' ? item.media : item.media_en;
  const fallbackMedia = locale === 'ru' ? item.media_en : item.media;
  const media = Array.isArray(localizedMedia) && localizedMedia.length > 0
    ? localizedMedia
    : (Array.isArray(fallbackMedia) ? fallbackMedia : []);
  const imageMedia = media.find((mediaItem) => mediaItem?.type !== 'video' && mediaItem?.path);
  const directImage = locale === 'ru'
    ? (item.image || item.image_en)
    : (item.image_en || item.image);
  return normalizePublicPath(directImage || imageMedia?.path);
}

async function resolvePublicImage(publicPath) {
  const normalized = normalizePublicPath(publicPath);
  if (!normalized) return null;
  const candidates = [
    path.join(publicDir, normalized),
    path.join(publishedDir, normalized),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function generateAvatar() {
  const inputPath = path.join(publicDir, 'avatar-small.png');
  if (!(await exists(inputPath))) return;

  const updated = await needsUpdate(inputPath, 'avatar-small');
  if (!updated) return;

  await sharp(inputPath)
    .resize({ width: 72, height: 72, fit: 'cover' })
    .webp({ quality: 76, effort: 6 })
    .toFile(path.join(publicDir, 'avatar-small.webp'));
}

async function generateSocialImage() {
  const inputPath = path.join(publicDir, 'avatar.png');
  if (!(await exists(inputPath))) return;

  const updated = await needsUpdate(inputPath, 'avatar');
  if (!updated) return;

  await sharp(inputPath)
    .resize({ width: 500, height: 500, fit: 'cover' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(publicDir, 'social-image.jpg'));
}

async function generatePostOgImages(feedItems) {
  const outputDir = path.join(publicDir, 'og/posts');
  await fs.mkdir(outputDir, { recursive: true });

  for (const item of feedItems) {
    const postId = item?.post_id;
    if (!postId) continue;

    const variants = [
      { locale: 'en', enabled: item.has_en && item.text_en, text: item.text_en, name: 'Alex Getman', image: postImagePath(item, 'en') },
      { locale: 'ru', enabled: item.has_ru && item.text, text: item.text, name: 'Алексей Гетманец', image: postImagePath(item, 'ru') },
    ];

    for (const variant of variants) {
      if (!variant.enabled) continue;
      const title = truncateText(getFirstSentence(variant.text) || `Post ${postId}`, 132);
      const lines = splitLines(title, variant.locale === 'ru' ? 27 : 30, 3);
      const badge = categoryLabel(variant.text, variant.locale);
      const sourceImage = await resolvePublicImage(variant.image);
      const sourceImageStamp = sourceImage ? (await fs.stat(sourceImage)).mtimeMs : 'none';
      const key = `og:v2:${postId}:${variant.locale}:${compactText(title)}:${badge}:${sourceImageStamp}`;
      const outputPath = path.join(outputDir, `post-${postId}-${variant.locale}.jpg`);

      if (cache[key] && await exists(outputPath)) continue;
      cache[key] = Date.now();

      const lineSvg = lines.map((line, index) =>
        `<text x="90" y="${275 + index * 76}" class="title">${escapeXml(line)}</text>`
      ).join('');

      const svg = `
        <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
          <rect width="1200" height="630" fill="${sourceImage ? 'rgba(8,11,16,0.55)' : '#080B10'}"/>
          ${sourceImage ? '<rect width="1200" height="630" fill="url(#shade)"/>' : '<rect x="0" y="0" width="1200" height="630" fill="url(#grid)" opacity="0.28"/>'}
          <rect x="70" y="74" width="1060" height="482" rx="28" fill="rgba(8,11,16,0.72)" stroke="rgba(243,246,250,0.18)" stroke-width="2"/>
          <text x="90" y="132" class="site">alexgetman.com</text>
          <text x="90" y="195" class="badge">${escapeXml(badge)}</text>
          ${lineSvg}
          <text x="90" y="510" class="meta">${escapeXml(variant.name)} / post ${escapeXml(postId)}</text>
          <circle cx="1058" cy="132" r="42" fill="#F04465" opacity="0.95"/>
          <text x="1041" y="146" class="mark">A</text>
          <defs>
            <linearGradient id="shade" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stop-color="rgba(8,11,16,0.18)"/>
              <stop offset="45%" stop-color="rgba(8,11,16,0.58)"/>
              <stop offset="100%" stop-color="rgba(8,11,16,0.9)"/>
            </linearGradient>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#202635" stroke-width="1"/>
            </pattern>
          </defs>
          <style>
            .site,.meta,.badge{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-weight:800;letter-spacing:0}
            .site{fill:#A3ADBC;font-size:28px}
            .badge{fill:#F04465;font-size:30px}
            .title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:58px;font-weight:850;fill:#F3F6FA;letter-spacing:0}
            .meta{fill:#A3ADBC;font-size:26px}
            .mark{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:38px;font-weight:900;fill:white}
          </style>
        </svg>
      `;

      const base = sourceImage
        ? await sharp(sourceImage)
            .resize({ width: 1200, height: 630, fit: 'cover' })
            .blur(1.2)
            .modulate({ brightness: 0.62, saturation: 0.72 })
            .jpeg({ quality: 88, mozjpeg: true })
            .toBuffer()
        : await sharp({
            create: { width: 1200, height: 630, channels: 3, background: '#080B10' }
          }).jpeg().toBuffer();

      await sharp(base)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .jpeg({ quality: 84, mozjpeg: true })
        .toFile(outputPath);
    }
  }
}

function responsiveOutputName(publicPath, width) {
  return String(publicPath)
    .replace(/^\/+/, '')
    .replace(/[\\/]/g, '-')
    .replace(/\.[a-z0-9]+$/i, `-${width}.webp`);
}

async function collectImages(dir, prefix = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const images = [];
  for (const entry of entries) {
    const publicPath = path.join(prefix, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (['generated', 'og', '.well-known'].includes(entry.name)) continue;
      images.push(...await collectImages(path.join(dir, entry.name), publicPath));
    } else if (/\.(png|jpe?g)$/i.test(entry.name)) {
      if (/^(avatar|social-image|favicon)/.test(publicPath)) continue;
      images.push(publicPath);
    }
  }
  return images;
}

async function generateResponsiveImages() {
  const outputDir = path.join(publicDir, 'generated/responsive');
  await fs.mkdir(outputDir, { recursive: true });
  const images = new Set(await collectImages(publicDir));
  for (const item of await loadFeedItems()) {
    for (const locale of ['en', 'ru']) {
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
      if (!updated && await exists(outputPath)) continue;
      await sharp(inputPath)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78, effort: 5 })
        .toFile(outputPath);
    }
  }
}

const feedItems = await loadFeedItems();
await generateAvatar();
await generateSocialImage();
await generatePostOgImages(feedItems);
await generateResponsiveImages();
await saveCache();
