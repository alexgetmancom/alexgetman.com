import fs from "node:fs";
import path from "node:path";
import { jsonObject } from "./json.js";

function tempPath(filePath: string): string {
  return `${filePath}.${process.pid}.tmp`;
}

export function atomicWriteText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = tempPath(filePath);
  fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o664 });
  fs.renameSync(temp, filePath);
}

export function atomicWriteJsonSync(filePath: string, value: unknown): void {
  atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = tempPath(filePath);
  await Bun.write(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.chmodSync(temp, 0o664);
  fs.renameSync(temp, filePath);
}

export function parseObject(value: unknown): Record<string, unknown> | null {
  const object = jsonObject(value);
  return Object.keys(object).length > 0 ? object : null;
}
