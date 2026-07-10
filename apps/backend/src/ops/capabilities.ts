import type { BackendDb } from "../db/client.js";
import { TARGETS } from "../botTargets.js";

export const MEDIA_TEST_CASES = [
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

const expectedTargets = ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"];

export function seedCapabilities(backendDb: BackendDb): void {
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    for (const [testId, formatKey, title, recipe] of MEDIA_TEST_CASES) {
      backendDb.sqlite.prepare(`INSERT INTO media_test_cases(test_id,format_key,title,input_recipe,expected_targets_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(test_id) DO UPDATE SET format_key=excluded.format_key,title=excluded.title,input_recipe=excluded.input_recipe,expected_targets_json=excluded.expected_targets_json,updated_at=excluded.updated_at`)
        .run(testId, formatKey, title, recipe, JSON.stringify(expectedTargets), now, now);
      for (const [target] of TARGETS) backendDb.sqlite.prepare("INSERT OR IGNORE INTO platform_capabilities(target,format_key,status,updated_at) VALUES (?,?,'unknown',?)").run(target, formatKey, now);
    }
  })();
}

export function recordCapabilityPost(backendDb: BackendDb, testId: string, messageId: number, notes?: string): string {
  seedCapabilities(backendDb);
  const test = backendDb.sqlite.prepare("SELECT * FROM media_test_cases WHERE test_id=?").get(testId) as Record<string, unknown> | undefined;
  if (!test) throw new Error(`unknown test: ${testId}`);
  const post = backendDb.sqlite.prepare("SELECT post_key FROM posts WHERE message_id=?").get(messageId) as { post_key: string } | undefined;
  if (!post) throw new Error(`message not found: ${messageId}`);
  const rows = backendDb.sqlite.prepare("SELECT * FROM post_targets WHERE post_key=?").all(post.post_key) as Record<string, unknown>[];
  const byTarget = new Map(rows.map((row) => [String(row.target), row]));
  const expected = JSON.parse(String(test.expected_targets_json)) as string[];
  const statuses: string[] = [];
  const now = new Date().toISOString();
  backendDb.sqlite.transaction(() => {
    for (const [target] of TARGETS) {
      const row = byTarget.get(target);
      const status = row?.status === "published" ? "supported" : row?.skipped ? "blocked" : row?.status === "failed" ? "failed" : "unknown";
      if (expected.includes(target)) statuses.push(status);
      backendDb.sqlite.prepare(`INSERT INTO media_test_results(test_id,target,message_id,status,external_id,url,error,notes,raw_json,checked_at)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(test_id,target,message_id) DO UPDATE SET status=excluded.status,external_id=excluded.external_id,url=excluded.url,error=excluded.error,notes=excluded.notes,raw_json=excluded.raw_json,checked_at=excluded.checked_at`)
        .run(testId, target, messageId, status, row?.external_id ?? null, row?.url ?? null, row?.error ?? null, notes ?? null, row?.raw_json ?? null, now);
      if (expected.includes(target) && ["supported", "failed", "blocked"].includes(status)) {
        backendDb.sqlite.prepare(`INSERT INTO platform_capabilities(target,format_key,status,evidence_test_id,evidence_message_id,evidence_url,notes,updated_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(target,format_key) DO UPDATE SET status=excluded.status,evidence_test_id=excluded.evidence_test_id,evidence_message_id=excluded.evidence_message_id,evidence_url=excluded.evidence_url,notes=excluded.notes,updated_at=excluded.updated_at`)
          .run(target, test.format_key, status, testId, messageId, row?.url ?? row?.external_id ?? null, notes ?? null, now);
      }
    }
    const testStatus = statuses.every((value) => value === "supported") ? "pass" : statuses.some((value) => value === "failed") ? "fail" : statuses.some((value) => value === "supported") ? "partial" : "pending";
    backendDb.sqlite.prepare("UPDATE media_test_cases SET status=?,last_message_id=?,notes=COALESCE(?,notes),updated_at=? WHERE test_id=?").run(testStatus, messageId, notes ?? null, now, testId);
  })();
  return String((backendDb.sqlite.prepare("SELECT status FROM media_test_cases WHERE test_id=?").get(testId) as { status: string }).status);
}

export function capabilitySummary(backendDb: BackendDb): Record<string, unknown>[] {
  seedCapabilities(backendDb);
  return backendDb.sqlite.prepare(`SELECT c.test_id,c.title,c.format_key,c.status,c.last_message_id,
    json_group_object(p.target,p.status) AS capabilities FROM media_test_cases c LEFT JOIN platform_capabilities p ON p.format_key=c.format_key GROUP BY c.test_id ORDER BY c.test_id`).all() as Record<string, unknown>[];
}
