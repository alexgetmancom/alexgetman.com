#!/usr/bin/env python3
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from posting_core.db import connect as db_connect, ensure_pipeline_schema
from posting_core.targets import ALL_TARGET_IDS as TARGETS

DATA_DIR = Path(os.environ.get("DATA_DIR", "/opt/telegram-to-threads/data"))
DB_PATH = Path(os.environ.get("PIPELINE_DB", str(DATA_DIR / "pipeline.db")))

TEST_CASES = [
    ("T01", "text_only", "Text only", "Send a plain text message.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T02", "text_picture", "Text + picture", "Send 1 photo with caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T03", "text_pictures", "Text + pictures", "Send album with 2 photos and caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T04", "text_video", "Text + video", "Send 1 video with caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T05", "text_videos", "Text + videos", "Send album with 2 videos and caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T06", "pictures_only", "Pictures only", "Send album with 2 photos, no caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T07", "videos_only", "Videos only", "Send album with 2 videos, no caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T08", "video_picture", "Video + picture", "Send album with 1 video and 1 photo with caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
    ("T09", "videos_pictures", "Videos + pictures", "Send mixed album with 2+ videos and 2+ photos with caption.", ["telegram", "site_ru", "site_en", "threads_ru", "linkedin"]),
]


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = db_connect(DB_PATH)
    ensure_pipeline_schema(conn)
    return conn


def seed(conn):
    ts = now_iso()
    for test_id, format_key, title, recipe, targets in TEST_CASES:
        conn.execute(
            """
            INSERT INTO media_test_cases(test_id, format_key, title, input_recipe, expected_targets_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(test_id) DO UPDATE SET
              format_key=excluded.format_key,
              title=excluded.title,
              input_recipe=excluded.input_recipe,
              expected_targets_json=excluded.expected_targets_json,
              updated_at=excluded.updated_at
            """,
            (test_id, format_key, title, recipe, json.dumps(targets), ts, ts),
        )
        for target in TARGETS:
            conn.execute(
                """
                INSERT INTO platform_capabilities(target, format_key, status, updated_at)
                VALUES (?, ?, 'unknown', ?)
                ON CONFLICT(target, format_key) DO NOTHING
                """,
                (target, format_key, ts),
            )
    conn.commit()


def init_db(args):
    with connect() as conn:
        seed(conn)
    print(f"initialized {DB_PATH}")


def list_tests(args):
    with connect() as conn:
        rows = conn.execute("SELECT * FROM media_test_cases ORDER BY test_id").fetchall()
    for row in rows:
        targets = ", ".join(json.loads(row["expected_targets_json"]))
        msg = row["last_message_id"] or ""
        print(f'{row["test_id"]}\t{row["status"]}\t{row["title"]}\tmsg={msg}\t{targets}')
        print(f'  {row["input_recipe"]}')


def capability_status_from_target(target_status):
    status = (target_status or {}).get("status") or "unknown"
    skipped = bool((target_status or {}).get("skipped"))
    if status == "published":
        return "supported"
    if skipped:
        return "blocked"
    if status == "failed":
        return "failed"
    return "unknown"


def test_status_from_targets(expected, results):
    relevant = [results.get(t, "unknown") for t in expected]
    if all(s == "supported" for s in relevant):
        return "pass"
    if any(s == "failed" for s in relevant):
        return "fail"
    if any(s == "supported" for s in relevant):
        return "partial"
    return "pending"


def record_post(args):
    with connect() as conn:
        seed(conn)
        case = conn.execute("SELECT * FROM media_test_cases WHERE test_id=?", (args.test,)).fetchone()
        if not case:
            raise SystemExit(f"unknown test_id: {args.test}")
        post = conn.execute("SELECT * FROM posts WHERE message_id=?", (args.message_id,)).fetchone()
        if not post:
            raise SystemExit(f"message_id not found in posts: {args.message_id}")
        rows = conn.execute("SELECT * FROM post_targets WHERE post_key=? ORDER BY target", (post["post_key"],)).fetchall()
        target_rows = {row["target"]: row for row in rows}
        expected = json.loads(case["expected_targets_json"])
        results = {}
        ts = now_iso()
        for target in TARGETS:
            row = target_rows.get(target)
            raw = json.loads(row["raw_json"]) if row and row["raw_json"] else None
            target_status = {
                "status": row["status"] if row else "unknown",
                "skipped": bool(row["skipped"]) if row else False,
            }
            status = capability_status_from_target(target_status)
            if target in expected:
                results[target] = status
            url = row["url"] if row else None
            external_id = row["external_id"] if row else None
            error = row["error"] if row else None
            conn.execute(
                """
                INSERT INTO media_test_results(test_id, target, message_id, status, external_id, url, error, notes, raw_json, checked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(test_id, target, message_id) DO UPDATE SET
                  status=excluded.status,
                  external_id=excluded.external_id,
                  url=excluded.url,
                  error=excluded.error,
                  notes=excluded.notes,
                  raw_json=excluded.raw_json,
                  checked_at=excluded.checked_at
                """,
                (args.test, target, args.message_id, status, external_id, url, error, args.notes, json.dumps(raw, ensure_ascii=False) if raw is not None else None, ts),
            )
            if target in expected and status in ("supported", "failed", "blocked"):
                evidence_url = url or external_id
                conn.execute(
                    """
                    INSERT INTO platform_capabilities(target, format_key, status, evidence_test_id, evidence_message_id, evidence_url, notes, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(target, format_key) DO UPDATE SET
                      status=excluded.status,
                      evidence_test_id=excluded.evidence_test_id,
                      evidence_message_id=excluded.evidence_message_id,
                      evidence_url=excluded.evidence_url,
                      notes=excluded.notes,
                      updated_at=excluded.updated_at
                    """,
                    (target, case["format_key"], status, args.test, args.message_id, evidence_url, args.notes, ts),
                )
        test_status = args.status or test_status_from_targets(expected, results)
        conn.execute(
            "UPDATE media_test_cases SET status=?, last_message_id=?, notes=COALESCE(?, notes), updated_at=? WHERE test_id=?",
            (test_status, args.message_id, args.notes, ts, args.test),
        )
        conn.commit()
    print(f"recorded {args.test} from message {args.message_id} as {test_status}")


def mark_capability(args):
    with connect() as conn:
        seed(conn)
        case = conn.execute("SELECT * FROM media_test_cases WHERE test_id=?", (args.test,)).fetchone()
        if not case:
            raise SystemExit(f"unknown test_id: {args.test}")
        ts = now_iso()
        conn.execute(
            """
            INSERT INTO platform_capabilities(target, format_key, status, evidence_test_id, evidence_message_id, evidence_url, notes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(target, format_key) DO UPDATE SET
              status=excluded.status,
              evidence_test_id=excluded.evidence_test_id,
              evidence_message_id=excluded.evidence_message_id,
              evidence_url=excluded.evidence_url,
              notes=excluded.notes,
              updated_at=excluded.updated_at
            """,
            (args.target, case["format_key"], args.status, args.test, args.message_id, args.url, args.notes, ts),
        )
        conn.commit()
    print(f"marked {args.target} {case['format_key']} as {args.status}")


def summary(args):
    with connect() as conn:
        seed(conn)
        cases = conn.execute("SELECT * FROM media_test_cases ORDER BY test_id").fetchall()
        caps = conn.execute("SELECT * FROM platform_capabilities").fetchall()
    cap_map = {(row["target"], row["format_key"]): row for row in caps}
    header = ["Test", "Format", "Status", *TARGETS]
    print("\t".join(header))
    for case in cases:
        row = [case["test_id"], case["title"], case["status"]]
        for target in TARGETS:
            cap = cap_map.get((target, case["format_key"]))
            row.append(cap["status"] if cap else "unknown")
        print("\t".join(row))


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("init").set_defaults(func=init_db)
    sub.add_parser("list").set_defaults(func=list_tests)
    sub.add_parser("summary").set_defaults(func=summary)

    record = sub.add_parser("record-post")
    record.add_argument("--test", required=True)
    record.add_argument("--message-id", required=True, type=int)
    record.add_argument("--status", choices=("pending", "pass", "partial", "fail", "skipped"))
    record.add_argument("--notes")
    record.set_defaults(func=record_post)

    mark = sub.add_parser("mark-capability")
    mark.add_argument("--test", required=True)
    mark.add_argument("--target", required=True, choices=TARGETS)
    mark.add_argument("--status", required=True, choices=("unknown", "supported", "partial", "failed", "blocked", "unsupported"))
    mark.add_argument("--message-id", type=int)
    mark.add_argument("--url")
    mark.add_argument("--notes")
    mark.set_defaults(func=mark_capability)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
