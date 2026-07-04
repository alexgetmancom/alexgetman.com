import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || '/home/deploy/ialexey-feed/data';
const prodFeedJsonPath = path.join(dataDir, 'feed.json');
const localFeedJsonPath = path.resolve('apps/web/src/data/feed.json');

export function loadFeedItems(): any[] {
  let parsedData: any = null;
  for (const filePath of [prodFeedJsonPath, localFeedJsonPath]) {
    if (!parsedData && fs.existsSync(filePath)) {
      try {
        parsedData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch (e) {
        console.error(`Error reading ${filePath}:`, e);
      }
    }
  }

  if (Array.isArray(parsedData)) return parsedData;
  if (parsedData?.items && Array.isArray(parsedData.items)) return parsedData.items;
  return [];
}
