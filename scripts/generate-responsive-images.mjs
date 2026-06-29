import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = process.cwd();
const publicDir = path.join(root, 'public');
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
      { locale: 'en', enabled: item.has_en && item.text_en, text: item.text_en, name: 'Alex Getman' },
      { locale: 'ru', enabled: item.has_ru && item.text, text: item.text, name: 'Алексей Гетманец' },
    ];

    for (const variant of variants) {
      if (!variant.enabled) continue;
      const title = truncateText(getFirstSentence(variant.text) || `Post ${postId}`, 132);
      const lines = splitLines(title, variant.locale === 'ru' ? 27 : 30, 4);
      const badge = categoryLabel(variant.text, variant.locale);
      const key = `og:${postId}:${variant.locale}:${compactText(title)}:${badge}`;
      const outputPath = path.join(outputDir, `post-${postId}-${variant.locale}.jpg`);

      if (cache[key] && await exists(outputPath)) continue;
      cache[key] = Date.now();

      const lineSvg = lines.map((line, index) =>
        `<text x="76" y="${205 + index * 82}" class="title">${escapeXml(line)}</text>`
      ).join('');

      const svg = `
        <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
          <rect width="1200" height="630" fill="#080B10"/>
          <rect x="0" y="0" width="1200" height="630" fill="url(#grid)" opacity="0.28"/>
          <rect x="76" y="74" width="1048" height="482" rx="28" fill="#111620" stroke="#202635" stroke-width="2"/>
          <text x="76" y="46" class="site">alexgetman.com</text>
          <text x="106" y="135" class="badge">${escapeXml(badge)}</text>
          ${lineSvg}
          <text x="76" y="596" class="meta">${escapeXml(variant.name)} / post ${escapeXml(postId)}</text>
          <circle cx="1060" cy="126" r="38" fill="#F04465" opacity="0.9"/>
          <text x="1044" y="139" class="mark">A</text>
          <defs>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M 48 0 L 0 0 0 48" fill="none" stroke="#202635" stroke-width="1"/>
            </pattern>
          </defs>
          <style>
            .site,.meta,.badge{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-weight:800;letter-spacing:0}
            .site{fill:#A3ADBC;font-size:28px}
            .badge{fill:#F04465;font-size:30px}
            .title{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:62px;font-weight:850;fill:#F3F6FA;letter-spacing:0}
            .meta{fill:#A3ADBC;font-size:26px}
            .mark{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;font-size:38px;font-weight:900;fill:white}
          </style>
        </svg>
      `;

      await sharp(Buffer.from(svg))
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
  const images = await collectImages(publicDir);

  for (const publicPath of images) {
    const inputPath = path.join(publicDir, publicPath);
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
