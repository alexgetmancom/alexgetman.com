from __future__ import annotations

import json
import os
import socket
from datetime import datetime, timedelta, timezone
from typing import Any

from posting_core.db import connect, ensure_pipeline_schema
from posting_core.time_utils import now_iso
from site_feed.config import PIPELINE_DB

SITE_JOB_CLAIM_LIMIT = int(os.environ.get("SITE_JOB_CLAIM_LIMIT", "20"))
SITE_JOB_MAX_ATTEMPTS = int(os.environ.get("SITE_JOB_MAX_ATTEMPTS", "5"))
SITE_JOB_BACKOFF_BASE_SECONDS = int(os.environ.get("SITE_JOB_BACKOFF_BASE_SECONDS", "60"))
SITE_JOB_BACKOFF_MAX_SECONDS = int(os.environ.get("SITE_JOB_BACKOFF_MAX_SECONDS", "900"))


def worker_id(prefix: str = "site-feed") -> str:
    return f"{prefix}:{socket.gethostname()}:{os.getpid()}"


def _next_retry_at(attempt: int) -> str:
    delay = min(SITE_JOB_BACKOFF_MAX_SECONDS, SITE_JOB_BACKOFF_BASE_SECONDS * (2 ** max(0, attempt - 1)))
    return (datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=delay)).isoformat()


def emit_site_event(conn, event_type: str, severity: str, message: str, details: dict[str, Any] | None = None) -> None:
    conn.execute(
        """
        INSERT INTO post_events(event_type, severity, message, details_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (event_type, severity, message, json.dumps(details or {}, ensure_ascii=False), now_iso()),
    )


def latest_site_build_status() -> dict[str, Any]:
    if not PIPELINE_DB.exists():
        return {"status": "unknown", "queue_depth": 0}
    with connect(PIPELINE_DB) as conn:
        ensure_pipeline_schema(conn)
        job = conn.execute(
            """
            SELECT status, last_error, updated_at, attempt_count
            FROM site_jobs
            WHERE status != 'cancelled'
            ORDER BY updated_at DESC, job_id DESC
            LIMIT 1
            """
        ).fetchone()
        event = conn.execute(
            """
            SELECT event_type, severity, message, details_json, created_at
            FROM post_events
            WHERE event_type LIKE 'site.build.%'
              AND event_type != 'site.build.cancelled'
            ORDER BY created_at DESC, id DESC
            LIMIT 1
            """
        ).fetchone()
        status_counts = {
            row["status"]: int(row["count"])
            for row in conn.execute("SELECT status, COUNT(*) AS count FROM site_jobs GROUP BY status").fetchall()
        }
        payload = {
            "status": job["status"] if job else "unknown",
            "last_error": job["last_error"] if job else None,
            "updated_at": job["updated_at"] if job else None,
            "attempt_count": int(job["attempt_count"] or 0) if job else 0,
            "queue_depth": status_counts.get("queued", 0) + status_counts.get("rendering", 0),
            "queued_count": status_counts.get("queued", 0),
            "rendering_count": status_counts.get("rendering", 0),
            "failed_count": status_counts.get("failed", 0),
        }
        if event:
            payload["last_event"] = dict(event)
        return payload


def enqueue_site_job(message_id: int = 0, post_id: int = 0, reason: str = "render") -> None:
    if not PIPELINE_DB.exists():
        return
    now = now_iso()
    with connect(PIPELINE_DB) as conn:
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO site_jobs(post_id, message_id, reason, status, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?)
            """,
            (int(post_id or 0) or None, int(message_id or -int(post_id or 0) or 0), reason, now, now),
        )
        conn.commit()


def claim_site_jobs(limit: int = SITE_JOB_CLAIM_LIMIT, worker: str | None = None) -> list[dict[str, Any]]:
    if not PIPELINE_DB.exists():
        return []
    worker = worker or worker_id()
    now = now_iso()
    with connect(PIPELINE_DB) as conn:
        ensure_pipeline_schema(conn)
        rows = conn.execute(
            """
            SELECT *
            FROM site_jobs
            WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at, job_id
            LIMIT ?
            """,
            (now, int(limit)),
        ).fetchall()
        claimed: list[dict[str, Any]] = []
        for row in rows:
            res = conn.execute(
                """
                UPDATE site_jobs
                SET status='rendering', locked_by=?, locked_at=?, updated_at=?
                WHERE job_id=? AND status='queued'
                """,
                (worker, now, now, row["job_id"]),
            )
            if res.rowcount == 1:
                claimed.append(dict(row))
        if claimed:
            emit_site_event(
                conn,
                "site.build.claimed",
                "info",
                f"claimed {len(claimed)} site build job(s)",
                {"job_ids": [job["job_id"] for job in claimed], "worker": worker},
            )
        conn.commit()
        return claimed


def complete_site_jobs(jobs: list[dict[str, Any]]) -> None:
    if not jobs or not PIPELINE_DB.exists():
        return
    now = now_iso()
    with connect(PIPELINE_DB) as conn:
        ensure_pipeline_schema(conn)
        conn.executemany(
            """
            UPDATE site_jobs
            SET status='published', locked_by=NULL, locked_at=NULL, last_error=NULL, updated_at=?
            WHERE job_id=?
            """,
            [(now, int(job["job_id"])) for job in jobs],
        )
        emit_site_event(
            conn,
            "site.build.published",
            "info",
            f"published {len(jobs)} site build job(s)",
            {"job_ids": [job["job_id"] for job in jobs]},
        )
        conn.commit()


def fail_site_jobs(jobs: list[dict[str, Any]], error: str) -> None:
    if not jobs or not PIPELINE_DB.exists():
        return
    now = now_iso()
    with connect(PIPELINE_DB) as conn:
        ensure_pipeline_schema(conn)
        params = []
        failed_ids = []
        retry_ids = []
        for job in jobs:
            attempt = int(job.get("attempt_count") or 0) + 1
            retry = attempt < SITE_JOB_MAX_ATTEMPTS
            status = "queued" if retry else "failed"
            next_attempt = _next_retry_at(attempt) if retry else None
            params.append((status, attempt, next_attempt, error, now, int(job["job_id"])))
            (retry_ids if retry else failed_ids).append(int(job["job_id"]))
        conn.executemany(
            """
            UPDATE site_jobs
            SET status=?, attempt_count=?, next_attempt_at=?, locked_by=NULL, locked_at=NULL, last_error=?, updated_at=?
            WHERE job_id=?
            """,
            params,
        )
        emit_site_event(
            conn,
            "site.build.failed" if failed_ids else "site.build.retry",
            "error" if failed_ids else "warn",
            error,
            {"failed_job_ids": failed_ids, "retry_job_ids": retry_ids},
        )
        conn.commit()
