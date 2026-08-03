import crypto from "node:crypto";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import type { ApplicationPorts } from "../application/ports.js";
import { draftStoryCards, drafts } from "../db/schema.js";
import { unsafeDb } from "../db/unsafe.js";
import { log } from "../foundation/logger.js";
import { buildStoryCardCopy } from "./copy.js";

export type StoryPublishMode = "all" | "site_only";

export function queueDraftStoryCards(backendDb: ApplicationPorts, draftId: number): void {
  const draft = unsafeDb(backendDb).db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) throw new Error(`draft ${draftId} not found`);
  if (mediaCount(draft.mediaRuJson) > 0 || mediaCount(draft.mediaEnJson) > 0) {
    discardDraftStoryCards(backendDb, draftId);
    unsafeDb(backendDb)
      .db.update(drafts)
      .set({ storyPublishMode: null, updatedAt: new Date().toISOString() })
      .where(eq(drafts.id, draftId))
      .run();
    return;
  }
  const now = new Date().toISOString();
  const stalePaths: string[] = [];
  const content = {
    ru: draft.textRu,
    en: draft.textEnApproved ?? draft.textEnMachine ?? draft.textRu,
  } as const;
  unsafeDb(backendDb).db.transaction((tx) => {
    let requeued = false;
    for (const locale of ["ru", "en"] as const) {
      const copy = buildStoryCardCopy(content[locale]);
      const sourceHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ locale, text: content[locale], template: copy.templateVersion }))
        .digest("hex");
      const current = tx
        .select()
        .from(draftStoryCards)
        .where(and(eq(draftStoryCards.draftId, draftId), eq(draftStoryCards.locale, locale)))
        .get();
      if (current?.sourceHash === sourceHash && current.status === "ready" && current.localPath && fs.existsSync(current.localPath))
        continue;
      if (current?.localPath) stalePaths.push(current.localPath);
      requeued = true;
      tx.insert(draftStoryCards)
        .values({
          draftId,
          locale,
          sourceHash,
          headline: copy.headline,
          emoji: copy.emoji,
          status: "queued",
          localPath: null,
          attemptCount: 0,
          nextAttemptAt: now,
          lockedBy: null,
          lockedAt: null,
          lastError: null,
          templateVersion: copy.templateVersion,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [draftStoryCards.draftId, draftStoryCards.locale],
          set: {
            sourceHash,
            headline: copy.headline,
            emoji: copy.emoji,
            status: "queued",
            localPath: null,
            attemptCount: 0,
            nextAttemptAt: now,
            lockedBy: null,
            lockedAt: null,
            lastError: null,
            templateVersion: copy.templateVersion,
            updatedAt: now,
          },
        })
        .run();
    }
    // Only a card that actually changed invalidates the editor's Story choice.
    // This runs on every draft save, so resetting unconditionally threw away the
    // "publish everywhere" decision each time an unrelated field was edited.
    if (requeued) tx.update(drafts).set({ storyPublishMode: null, updatedAt: now }).where(eq(drafts.id, draftId)).run();
  });
  removeFiles(stalePaths);
}

export function storyCardsForDraft(backendDb: ApplicationPorts, draftId: number) {
  return unsafeDb(backendDb).db.select().from(draftStoryCards).where(eq(draftStoryCards.draftId, draftId)).all();
}

export function readyStoryCardMedia(backendDb: ApplicationPorts, draftId: number): Record<"ru" | "en", Record<string, unknown>> | null {
  const rows = storyCardsForDraft(backendDb, draftId);
  const byLocale = new Map(rows.map((row) => [row.locale, row]));
  const ru = byLocale.get("ru");
  const en = byLocale.get("en");
  if (!ready(ru) || !ready(en)) return null;
  return {
    ru: mediaItem(ru.localPath),
    en: mediaItem(en.localPath),
  };
}

export function setStoryPublishMode(backendDb: ApplicationPorts, draftId: number, mode: StoryPublishMode): void {
  const now = new Date().toISOString();
  unsafeDb(backendDb).db.update(drafts).set({ storyPublishMode: mode, updatedAt: now }).where(eq(drafts.id, draftId)).run();
}

export function discardDraftStoryCards(backendDb: ApplicationPorts, draftId: number): void {
  const paths = storyCardsForDraft(backendDb, draftId).flatMap((card) => (card.localPath ? [card.localPath] : []));
  unsafeDb(backendDb).db.delete(draftStoryCards).where(eq(draftStoryCards.draftId, draftId)).run();
  removeFiles(paths);
}

function ready(row: typeof draftStoryCards.$inferSelect | undefined): row is typeof draftStoryCards.$inferSelect & { localPath: string } {
  return Boolean(row?.status === "ready" && row.localPath && fs.existsSync(row.localPath));
}

function mediaItem(localPath: string): Record<string, unknown> {
  return {
    type: "IMAGE",
    local_path: localPath,
    localPath,
    story_local_path: localPath,
    storyLocalPath: localPath,
    role: "text_story_card",
  };
}

function mediaCount(value: string | null): number {
  try {
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function removeFiles(paths: string[]): void {
  for (const file of paths) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        log("warn", "failed to remove stale Story card", { file, error });
    }
  }
}
