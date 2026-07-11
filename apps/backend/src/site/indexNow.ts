import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendConfig } from "../config.js";
import { log } from "../logger.js";

type IndexNowState = { last_digest?: string; last_attempt_at?: string; last_success_at?: string; last_status?: number; url_count?: number };

export async function pingIndexNow(config: BackendConfig, urls: string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!config.INDEXNOW_ENABLED) return;
  const unique = [...new Set(urls)].sort().slice(0, 100);
  if (unique.length === 0) return;
  const keyFile = path.join(config.DATA_DIR, "indexnow.key");
  const stateFile = path.join(config.DATA_DIR, "indexnow.json");
  const key = readOrCreateKey(keyFile);
  fs.writeFileSync(path.join(config.SITE_PUBLIC_DIR, `${key}.txt`), `${key}\n`, { encoding: "utf8", mode: 0o664 });
  const digest = crypto.createHash("sha256").update(unique.join("\n")).digest("hex");
  const previous = readState(stateFile);
  if (previous.last_digest === digest) return;
  const state: IndexNowState = { last_digest: digest, last_attempt_at: new Date().toISOString(), url_count: unique.length };
  writeState(stateFile, state);
  try {
    const response = await fetchImpl("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: new URL(config.PUBLIC_BASE_URL).host,
        key,
        keyLocation: `${config.PUBLIC_BASE_URL.replace(/\/$/, "")}/${key}.txt`,
        urlList: unique,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    state.last_status = response.status;
    if (response.ok || response.status === 202) state.last_success_at = new Date().toISOString();
    writeState(stateFile, state);
    if (!response.ok && response.status !== 202) log("warn", "IndexNow request rejected", { status: response.status, urls: unique.length });
  } catch (error) {
    log("warn", "IndexNow request failed", { error: String(error) });
  }
}

function readOrCreateKey(filePath: string): string {
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    if (/^[a-f0-9-]{8,128}$/i.test(value)) return value;
  } catch {}
  const value = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${value}\n`, { encoding: "utf8", mode: 0o664 });
  return value;
}

function readState(filePath: string): IndexNowState {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as IndexNowState;
  } catch {
    return {};
  }
}

function writeState(filePath: string, state: IndexNowState): void {
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o664 });
}
