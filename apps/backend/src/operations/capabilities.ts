import { asc, eq, sql } from "drizzle-orm";
import { TARGETS } from "../botTargets.js";
import type { BackendDb } from "../db/client.js";
import { mediaTestCases, mediaTestResults, platformCapabilities, posts, postTargets } from "../db/schema.js";

const MEDIA_TEST_CASES = [
  ["T01", "text_only", "Text only", "Send a plain text message."],
  ["T02", "text_picture", "Text + picture", "Send 1 photo with caption."],
  ["T03", "text_pictures", "Text + pictures", "Send album with 2 photos and caption."],
  ["T04", "text_video", "Text + video", "Send 1 video with caption."],
  ["T05", "text_videos", "Text + videos", "Send album with 2 videos and caption."],
  ["T06", "pictures_only", "Pictures only", "Send album with 2 photos, no caption."],
  ["T07", "videos_only", "Videos only", "Send album with 2 videos, no caption."],
  ["T08", "video_picture", "Video + picture", "Send album with 1 video and 1 photo with caption."],
  ["T09", "videos_pictures", "Videos + pictures", "Send mixed photo/video album with caption."],
] as const;

const expectedTargets = ["telegram", "site_ru", "site_en", "threads_ru"];

/** Operations fixture registry for supported delivery capabilities. */
export function seedCapabilities(backendDb: BackendDb): void {
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    for (const [testId, formatKey, title, recipe] of MEDIA_TEST_CASES) {
      tx.insert(mediaTestCases)
        .values({
          testId,
          formatKey,
          title,
          inputRecipe: recipe,
          expectedTargetsJson: JSON.stringify(expectedTargets),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: mediaTestCases.testId,
          set: { formatKey, title, inputRecipe: recipe, expectedTargetsJson: JSON.stringify(expectedTargets), updatedAt: now },
        })
        .run();
      for (const [target] of TARGETS)
        tx.insert(platformCapabilities).values({ target, formatKey, status: "unknown", updatedAt: now }).onConflictDoNothing().run();
    }
  });
}

export function recordCapabilityPost(backendDb: BackendDb, testId: string, messageId: number, notes?: string): string {
  seedCapabilities(backendDb);
  const test = backendDb.db.select().from(mediaTestCases).where(eq(mediaTestCases.testId, testId)).get();
  if (!test) throw new Error(`unknown test: ${testId}`);
  const post = backendDb.db.select({ postKey: posts.postKey }).from(posts).where(eq(posts.messageId, messageId)).get();
  if (!post) throw new Error(`message not found: ${messageId}`);
  const rows = backendDb.db.select().from(postTargets).where(eq(postTargets.postKey, post.postKey)).all();
  const byTarget = new Map(rows.map((row) => [row.target, row]));
  const expected = JSON.parse(test.expectedTargetsJson) as string[];
  const statuses: string[] = [];
  const now = new Date().toISOString();
  backendDb.db.transaction((tx) => {
    for (const [target] of TARGETS) {
      const row = byTarget.get(target);
      const status = row?.status === "published" ? "supported" : row?.skipped ? "blocked" : row?.status === "failed" ? "failed" : "unknown";
      if (expected.includes(target)) statuses.push(status);
      tx.insert(mediaTestResults)
        .values({
          testId,
          target,
          messageId,
          status,
          externalId: row?.externalId ?? null,
          url: row?.url ?? null,
          error: row?.error ?? null,
          notes: notes ?? null,
          rawJson: row?.rawJson ?? null,
          checkedAt: now,
        })
        .onConflictDoUpdate({
          target: [mediaTestResults.testId, mediaTestResults.target, mediaTestResults.messageId],
          set: {
            status,
            externalId: row?.externalId ?? null,
            url: row?.url ?? null,
            error: row?.error ?? null,
            notes: notes ?? null,
            rawJson: row?.rawJson ?? null,
            checkedAt: now,
          },
        })
        .run();
      if (expected.includes(target) && ["supported", "failed", "blocked"].includes(status)) {
        tx.insert(platformCapabilities)
          .values({
            target,
            formatKey: test.formatKey,
            status,
            evidenceTestId: testId,
            evidenceMessageId: messageId,
            evidenceUrl: row?.url ?? row?.externalId ?? null,
            notes: notes ?? null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [platformCapabilities.target, platformCapabilities.formatKey],
            set: {
              status,
              evidenceTestId: testId,
              evidenceMessageId: messageId,
              evidenceUrl: row?.url ?? row?.externalId ?? null,
              notes: notes ?? null,
              updatedAt: now,
            },
          })
          .run();
      }
    }
    const testStatus = statuses.every((value) => value === "supported")
      ? "pass"
      : statuses.some((value) => value === "failed")
        ? "fail"
        : statuses.some((value) => value === "supported")
          ? "partial"
          : "pending";
    tx.update(mediaTestCases)
      .set({ status: testStatus, lastMessageId: messageId, ...(notes ? { notes } : {}), updatedAt: now })
      .where(eq(mediaTestCases.testId, testId))
      .run();
  });
  return (
    backendDb.db.select({ status: mediaTestCases.status }).from(mediaTestCases).where(eq(mediaTestCases.testId, testId)).get()?.status ??
    "pending"
  );
}

export function capabilitySummary(backendDb: BackendDb): Record<string, unknown>[] {
  return backendDb.db
    .select({
      testId: mediaTestCases.testId,
      title: mediaTestCases.title,
      formatKey: mediaTestCases.formatKey,
      status: mediaTestCases.status,
      lastMessageId: mediaTestCases.lastMessageId,
      capabilities: sql<string>`json_group_object(${platformCapabilities.target}, ${platformCapabilities.status})`,
    })
    .from(mediaTestCases)
    .leftJoin(platformCapabilities, eq(platformCapabilities.formatKey, mediaTestCases.formatKey))
    .groupBy(mediaTestCases.testId)
    .orderBy(asc(mediaTestCases.testId))
    .all();
}
