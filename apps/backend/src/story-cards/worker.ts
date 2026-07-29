import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { BackendDb } from "../db/client.js";
import { draftStoryCards } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { recordWorkerState } from "../foundation/runtime/worker-state.js";
import { buildStoryCardCopy } from "./copy.js";

type ClaimedCard = typeof draftStoryCards.$inferSelect & { lockedBy: string; lockedAt: string };

export async function runStoryCardCycle(config: BackendConfig, backendDb: BackendDb): Promise<number> {
  recoverStoryCardJobs(backendDb);
  const card = claimStoryCard(backendDb);
  if (!card) {
    recordWorkerState(backendDb, "story-cards", { claimed: 0 });
    return 0;
  }
  try {
    const output = outputPath(config, card);
    await renderStoryCard(config, card, output);
    const now = new Date().toISOString();
    backendDb.db
      .update(draftStoryCards)
      .set({
        status: "ready",
        localPath: output,
        lockedBy: null,
        lockedAt: null,
        nextAttemptAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(draftStoryCards.draftId, card.draftId),
          eq(draftStoryCards.locale, card.locale),
          eq(draftStoryCards.status, "rendering"),
          eq(draftStoryCards.lockedBy, card.lockedBy),
        ),
      )
      .run();
    recordWorkerState(backendDb, "story-cards", { claimed: 1, published: 1 });
  } catch (error) {
    const attempt = card.attemptCount + 1;
    const retry = attempt < config.STORY_CARD_MAX_ATTEMPTS;
    const now = new Date().toISOString();
    backendDb.db
      .update(draftStoryCards)
      .set({
        status: retry ? "queued" : "failed",
        attemptCount: attempt,
        nextAttemptAt: retry ? new Date(Date.now() + attempt * 5_000).toISOString() : null,
        lockedBy: null,
        lockedAt: null,
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: now,
      })
      .where(
        and(
          eq(draftStoryCards.draftId, card.draftId),
          eq(draftStoryCards.locale, card.locale),
          eq(draftStoryCards.status, "rendering"),
          eq(draftStoryCards.lockedBy, card.lockedBy),
        ),
      )
      .run();
    recordWorkerState(backendDb, "story-cards", { claimed: 1, failed: 1 }, error instanceof Error ? error.message : String(error));
  }
  return 1;
}

export function recoverStoryCardJobs(backendDb: BackendDb, staleAfterMs = 60_000): number {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const now = new Date().toISOString();
  return backendDb.db
    .update(draftStoryCards)
    .set({ status: "queued", lockedBy: null, lockedAt: null, nextAttemptAt: now, updatedAt: now })
    .where(and(eq(draftStoryCards.status, "rendering"), lt(draftStoryCards.lockedAt, cutoff)))
    .returning({ draftId: draftStoryCards.draftId })
    .all().length;
}

function claimStoryCard(backendDb: BackendDb): ClaimedCard | null {
  const now = new Date().toISOString();
  const candidate = backendDb.db
    .select()
    .from(draftStoryCards)
    .where(and(eq(draftStoryCards.status, "queued"), or(isNull(draftStoryCards.nextAttemptAt), lte(draftStoryCards.nextAttemptAt, now))))
    .orderBy(asc(draftStoryCards.createdAt), asc(draftStoryCards.draftId), asc(draftStoryCards.locale))
    .get();
  if (!candidate) return null;
  const lockId = `story-card:${process.pid}:${crypto.randomUUID()}`;
  const claimed = backendDb.db
    .update(draftStoryCards)
    .set({ status: "rendering", lockedBy: lockId, lockedAt: now, updatedAt: now })
    .where(
      and(
        eq(draftStoryCards.draftId, candidate.draftId),
        eq(draftStoryCards.locale, candidate.locale),
        eq(draftStoryCards.status, "queued"),
      ),
    )
    .returning()
    .get();
  return claimed?.lockedBy && claimed.lockedAt ? (claimed as ClaimedCard) : null;
}

async function renderStoryCard(config: BackendConfig, card: ClaimedCard, output: string): Promise<void> {
  fs.mkdirSync(config.STORY_CARD_DIR, { recursive: true });
  const fontConfig = path.join(config.STORY_CARD_DIR, "fontconfig.xml");
  if (!fs.existsSync(fontConfig)) fs.writeFileSync(fontConfig, fontConfigXml(config.STORY_CARD_ASSETS_DIR));
  const copy = buildStoryCardCopy(card.headline);
  copy.emoji = card.emoji;
  copy.headline = card.headline;
  const child = Bun.spawn([process.execPath, config.STORY_CARD_RENDERER_ENTRY], {
    stdin: Buffer.from(
      JSON.stringify({
        backgroundPath: path.join(config.STORY_CARD_ASSETS_DIR, "strata-master-background.png"),
        outputPath: output,
        copy,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FONTCONFIG_FILE: fontConfig },
  });
  const timer = setTimeout(() => child.kill(), config.STORY_CARD_TIMEOUT_SECONDS * 1000);
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(`story_card_renderer_failed: ${stderr.slice(0, 800) || `exit ${exitCode}`}`);
    if (!fs.existsSync(output)) throw new Error("story_card_renderer_failed: output missing");
  } finally {
    clearTimeout(timer);
  }
}

function outputPath(config: BackendConfig, card: ClaimedCard): string {
  return path.join(config.STORY_CARD_DIR, `draft-${card.draftId}-${card.locale}-${card.sourceHash.slice(0, 16)}.jpg`);
}

function fontConfigXml(assetsDir: string): string {
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${escapeXml(
    assetsDir,
  )}</dir><cachedir>/tmp/story-card-font-cache</cachedir></fontconfig>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
