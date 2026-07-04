from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from site_feed.config import CONTROLLER_DB, PIPELINE_DB, log, now_iso

def db_rows(path, query, params=()):
    try:
        import sqlite3
        if not Path(path).exists():
            return []
        conn = sqlite3.connect(str(path), timeout=2)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in conn.execute(query, params).fetchall()]
        finally:
            conn.close()
    except Exception as exc:
        log(f"Ошибка чтения DB {path}: {exc}")
        return []


def db_scalar(path, query, params=(), fallback=0):
    try:
        if not Path(path).exists():
            return fallback
        conn = sqlite3.connect(str(path), timeout=2)
        try:
            row = conn.execute(query, params).fetchone()
            return row[0] if row else fallback
        finally:
            conn.close()
    except Exception as exc:
        log(f"Ошибка чтения DB {path}: {exc}")
        return fallback


def processed_count():
    rows = db_rows(PIPELINE_DB, "SELECT state_json FROM worker_state WHERE name='telegram_to_threads'")
    if not rows:
        return 0
    try:
        return len(json.loads(rows[0].get("state_json") or "{}").get("processed_message_ids", []))
    except Exception:
        return 0


def command_center_payload():
    queue = db_rows(
        PIPELINE_DB,
        """
        SELECT job_id, message_id, target, status, attempt_count, publish_at, next_attempt_at,
               locked_by, locked_at, last_error, created_at, updated_at, post_id
        FROM publish_jobs
        WHERE status IN ('queued', 'publishing', 'failed')
        ORDER BY created_at DESC
        LIMIT 100
        """,
    )
    plans_count = db_scalar(PIPELINE_DB, "SELECT COUNT(*) FROM publish_plans")
    drafts = db_rows(
        CONTROLLER_DB,
        "SELECT id, status, text_ru, text_en_approved, targets_json, media_ru_json, media_en_json, channel_message_id, scheduled_at, scheduled_en_at, created_at, updated_at FROM drafts ORDER BY id DESC LIMIT 40",
    )
    lifecycle = db_rows(
        PIPELINE_DB,
        """
        SELECT l.*, p.message_id, p.text, p.text_en, p.media_count, p.media_types_json
        FROM post_lifecycle l
        LEFT JOIN posts p ON p.post_key = l.post_key
        ORDER BY l.updated_at DESC
        LIMIT 80
        """,
    )
    targets = db_rows(
        PIPELINE_DB,
        """
        SELECT p.message_id AS telegram_message_id, t.*
        FROM post_targets t
        LEFT JOIN posts p ON p.post_key = t.post_key
        ORDER BY t.updated_at DESC
        LIMIT 160
        """,
    )
    errors = [row for row in targets if row.get("status") == "failed" or row.get("error")]
    events = db_rows(
        PIPELINE_DB,
        "SELECT * FROM post_events ORDER BY created_at DESC LIMIT 80",
    )
    credentials = db_rows(
        PIPELINE_DB,
        "SELECT * FROM credential_checks ORDER BY target",
    )
    media_assets = db_rows(
        PIPELINE_DB,
        "SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 120",
    )
    capabilities = db_rows(
        PIPELINE_DB,
        "SELECT * FROM platform_capabilities ORDER BY target, format_key",
    )
    platform_rules = db_rows(
        PIPELINE_DB,
        "SELECT * FROM platform_rules ORDER BY target, format_key",
    )
    analytics = db_rows(
        PIPELINE_DB,
        "SELECT * FROM analytics_rollups ORDER BY scope, subject",
    )
    memory = db_rows(
        PIPELINE_DB,
        "SELECT * FROM content_memory ORDER BY updated_at DESC LIMIT 60",
    )
    return {
        "updated_at": now_iso(),
        "drafts": drafts,
        "queue": queue,
        "plans_count": plans_count,
        "processed_count": processed_count(),
        "lifecycle": lifecycle,
        "targets": targets,
        "errors": errors,
        "events": events,
        "credentials": credentials,
        "media_assets": media_assets,
        "capabilities": capabilities,
        "platform_rules": platform_rules,
        "analytics": analytics,
        "memory": memory,
    }
