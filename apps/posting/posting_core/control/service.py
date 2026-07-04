from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime, timezone

from posting_core.control.config import BACKUP_DIR, DB_PATH, json_dumps, now_iso
from posting_core.db import connect as db_connect, ensure_pipeline_schema
from posting_core.control.lifecycle import sync_lifecycle
from posting_core.control.assets import sync_media_assets
from posting_core.control.memory import sync_content_memory, sync_analytics
from posting_core.control.credentials import sync_credentials
from posting_core.control.alerts import scan_observability

def sync_control_plane(conn):
    ensure_pipeline_schema(conn)
    sync_lifecycle(conn)
    sync_media_assets(conn)
    sync_content_memory(conn)
    sync_analytics(conn)
    sync_credentials(conn)
    scan_observability(conn)


def command_center_payload(conn):
    ensure_pipeline_schema(conn)
    queue = [
        dict(row)
        for row in conn.execute(
            """
            SELECT job_id, message_id, target, status, attempt_count, publish_at, next_attempt_at,
                   locked_by, locked_at, last_error, created_at, updated_at
            FROM publish_jobs
            WHERE status IN ('queued', 'publishing', 'failed')
            ORDER BY created_at DESC
            LIMIT 100
            """
        )
    ]
    plans_count = conn.execute("SELECT COUNT(*) FROM publish_plans").fetchone()[0]
    worker_state = conn.execute("SELECT state_json FROM worker_state WHERE name='telegram_to_threads'").fetchone()
    try:
        processed_count = len(json.loads(worker_state["state_json"] or "{}").get("processed_message_ids", [])) if worker_state else 0
    except Exception:
        processed_count = 0
    lifecycle = [dict(row) for row in conn.execute("SELECT * FROM post_lifecycle ORDER BY updated_at DESC LIMIT 50")]
    errors = [dict(row) for row in conn.execute("SELECT * FROM post_events WHERE severity IN ('error','warn') ORDER BY created_at DESC LIMIT 50")]
    creds = [dict(row) for row in conn.execute("SELECT * FROM credential_checks ORDER BY target")]
    rollups = [dict(row) for row in conn.execute("SELECT * FROM analytics_rollups ORDER BY scope, subject")]
    assets = [dict(row) for row in conn.execute("SELECT * FROM media_assets ORDER BY updated_at DESC LIMIT 80")]
    rules = [dict(row) for row in conn.execute("SELECT * FROM platform_rules ORDER BY target, format_key")]
    return {
        "updated_at": now_iso(),
        "queue": queue,
        "plans_count": plans_count,
        "processed_count": processed_count,
        "lifecycle": lifecycle,
        "events": errors,
        "credentials": creds,
        "analytics": rollups,
        "media_assets": assets,
        "platform_rules": rules,
    }


def backup_db(args):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = BACKUP_DIR / f"pipeline-{ts}.db"
    if not DB_PATH.exists():
        raise SystemExit(f"missing DB: {DB_PATH}")
    shutil.copy2(DB_PATH, dest)
    git_sha = current_git_sha()
    with db_connect(DB_PATH) as conn:
        ensure_pipeline_schema(conn)
        conn.execute(
            "INSERT INTO deployment_snapshots(git_sha, action, status, backup_path, details_json, created_at) VALUES (?, 'backup', 'ok', ?, ?, ?)",
            (git_sha, str(dest), json_dumps({"source": str(DB_PATH)}), now_iso()),
        )
        conn.commit()
    print(dest)


def current_git_sha():
    try:
        res = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            return res.stdout.strip()
    except Exception:
        pass
    return None
