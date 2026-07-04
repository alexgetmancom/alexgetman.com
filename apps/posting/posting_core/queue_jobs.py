from __future__ import annotations

import json
import os
import socket
from typing import Any

from .db import connect, ensure_pipeline_schema
from .paths import PostingPaths, get_paths
from .time_utils import now_iso
from .queue_errors import MAX_ATTEMPTS, classify_publish_error, next_retry_at, normalize_publish_result

CHANNEL_USERNAME = os.environ.get("CHANNEL_USERNAME", "alexgetmancom").lstrip("@")

def _post_key_for(conn, message_id: int) -> str:
    try:
        row = conn.execute("SELECT post_key FROM posts WHERE message_id=?", (message_id,)).fetchone()
    except Exception:
        row = None
    return row["post_key"] if row else f"telegram:{CHANNEL_USERNAME}:{int(message_id)}"


def _job_post_key(conn, row) -> str:
    if row["post_key"]:
        return row["post_key"]
    if "post_id" in row.keys() and row["post_id"]:
        return f"post:{int(row['post_id'])}"
    return _post_key_for(conn, int(row["message_id"]))


def worker_id(prefix: str = "posting-app") -> str:
    return f"{prefix}:{socket.gethostname()}:{os.getpid()}"


def _event(conn, post_key: str | None, target: str | None, event_type: str, severity: str, message: str, details: dict[str, Any] | None = None) -> None:
    conn.execute(
        """
        INSERT INTO post_events(post_key, event_type, severity, target, message, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (post_key, event_type, severity, target, message, json.dumps(details or {}, ensure_ascii=False), now_iso()),
    )


def claim_due_publish_jobs(limit: int = 20, worker: str | None = None, paths: PostingPaths | None = None) -> list[dict[str, Any]]:
    paths = paths or get_paths()
    if not paths.pipeline_db.exists():
        return []
    worker = worker or worker_id()
    now = now_iso()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        rows = conn.execute(
            """
            SELECT *
            FROM publish_jobs
            WHERE status='queued'
              AND (publish_at IS NULL OR publish_at <= ?)
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at, job_id
            LIMIT ?
            """,
            (now, now, int(limit)),
        ).fetchall()
        claimed: list[dict[str, Any]] = []
        for row in rows:
            res = conn.execute(
                """
                UPDATE publish_jobs
                SET status='publishing', locked_by=?, locked_at=?, updated_at=?
                WHERE job_id=? AND status='queued'
                """,
                (worker, now, now, row["job_id"]),
            )
            if res.rowcount != 1:
                continue
            post_key = _job_post_key(conn, row)
            conn.execute(
                """
                INSERT INTO post_targets(post_key, target, status, error, skipped, updated_at, raw_json)
                VALUES (?, ?, 'publishing', NULL, 0, ?, ?)
                ON CONFLICT(post_key, target) DO UPDATE SET
                    status='publishing',
                    error=NULL,
                    skipped=0,
                    updated_at=excluded.updated_at,
                    raw_json=excluded.raw_json
                """,
                (post_key, row["target"], now, json.dumps({"job_id": row["job_id"], "worker": worker}, ensure_ascii=False)),
            )
            subject = f"post {row['post_id']}" if row["post_id"] else f"message {row['message_id']}"
            _event(conn, post_key, row["target"], "publish.job.claimed", "info", f"Publishing {row['target']} for {subject}", {"job_id": row["job_id"], "worker": worker})
            payload = json.loads(row["payload_json"] or "{}")
            claimed.append({
                "job_id": row["job_id"],
                "post_key": post_key,
                "message_id": row["message_id"],
                "post_id": row["post_id"],
                "target": row["target"],
                "payload": payload if isinstance(payload, dict) else {},
                "attempt_count": row["attempt_count"],
            })
        conn.commit()
        return claimed


def complete_publish_job(job_id: int, result: dict[str, Any], paths: PostingPaths | None = None) -> None:
    paths = paths or get_paths()
    if not paths.pipeline_db.exists():
        return
    now = now_iso()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        job = conn.execute("SELECT * FROM publish_jobs WHERE job_id=?", (int(job_id),)).fetchone()
        if not job:
            return
        post_key = _job_post_key(conn, job)
        status, external_id, external_ids, url, error, skipped, raw = normalize_publish_result(result)
        conn.execute(
            """
            DELETE FROM publish_jobs
            WHERE COALESCE(post_id, message_id)=COALESCE(?, ?)
              AND target=? AND status=? AND job_id<>?
            """,
            (job["post_id"], job["message_id"], job["target"], status, int(job_id)),
        )
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(post_key, target) DO UPDATE SET
                status=excluded.status,
                external_id=CASE WHEN excluded.status='published' THEN excluded.external_id ELSE NULL END,
                external_ids_json=CASE WHEN excluded.status='published' THEN excluded.external_ids_json ELSE NULL END,
                url=CASE WHEN excluded.status='published' THEN excluded.url ELSE NULL END,
                error=excluded.error,
                skipped=excluded.skipped,
                updated_at=excluded.updated_at,
                raw_json=excluded.raw_json
            """,
            (post_key, job["target"], status, external_id, json.dumps(external_ids, ensure_ascii=False) if external_ids is not None else None, url, error, skipped, now, raw),
        )
        conn.execute(
            """
            UPDATE publish_jobs
            SET status=?, locked_by=NULL, locked_at=NULL, last_error=?, updated_at=?
            WHERE job_id=?
            """,
            (status, error, now, int(job_id)),
        )
        _event(conn, post_key, job["target"], f"publish.job.{status}", "info" if status in {"published", "skipped"} else "error", f"{job['target']} {status}", {"job_id": job_id, "result": result})
        conn.commit()


def fail_publish_job(job_id: int, error: Any, paths: PostingPaths | None = None) -> None:
    paths = paths or get_paths()
    if not paths.pipeline_db.exists():
        return
    now = now_iso()
    error_text = str(error)
    error_class = classify_publish_error(error)
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        job = conn.execute("SELECT * FROM publish_jobs WHERE job_id=?", (int(job_id),)).fetchone()
        if not job:
            return
        post_key = _job_post_key(conn, job)
        attempt = int(job["attempt_count"] or 0) + 1
        should_retry = error_class == "transient" and attempt < MAX_ATTEMPTS
        new_status = "queued" if should_retry else "failed"
        next_attempt = next_retry_at(attempt) if should_retry else None
        if new_status != "queued":
            conn.execute(
                """
                DELETE FROM publish_jobs
                WHERE COALESCE(post_id, message_id)=COALESCE(?, ?)
                  AND target=? AND status=? AND job_id<>?
                """,
                (job["post_id"], job["message_id"], job["target"], new_status, int(job_id)),
            )
        conn.execute(
            """
            UPDATE publish_jobs
            SET status=?, attempt_count=?, next_attempt_at=?, locked_by=NULL, locked_at=NULL, last_error=?, updated_at=?
            WHERE job_id=?
            """,
            (new_status, attempt, next_attempt, error_text, now, int(job_id)),
        )
        target_status = "queued" if should_retry else "failed"
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, error, skipped, updated_at, raw_json)
            VALUES (?, ?, ?, ?, 0, ?, ?)
            ON CONFLICT(post_key, target) DO UPDATE SET
                status=excluded.status,
                error=excluded.error,
                skipped=0,
                updated_at=excluded.updated_at,
                raw_json=excluded.raw_json
            """,
            (post_key, job["target"], target_status, error_text, now, json.dumps({"job_id": job_id, "error_class": error_class, "attempt": attempt, "next_attempt_at": next_attempt}, ensure_ascii=False)),
        )
        severity = "warn" if should_retry else "error"
        _event(conn, post_key, job["target"], "publish.job.retry" if should_retry else "publish.job.failed", severity, error_text, {"job_id": job_id, "error_class": error_class, "attempt": attempt, "next_attempt_at": next_attempt})
        conn.commit()
