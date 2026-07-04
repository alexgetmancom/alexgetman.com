from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path

from posting_core.metrics_config import SCHEDULED_TARGETS, iso_utc, utc_now_dt

UNSUPPORTED_METRIC_TARGETS = ("x", "linkedin")
MAINTENANCE_LOCK_NAME = "metrics_maintenance"


def split_targets(value: str | None) -> tuple[str, ...]:
    if not value:
        return tuple(SCHEDULED_TARGETS)
    requested = tuple(part.strip() for part in value.split(",") if part.strip())
    return tuple(target for target in requested if target in SCHEDULED_TARGETS)


def build_backfill_plan(conn, targets: tuple[str, ...], refs: list[str] | None = None, date_from: str | None = None, date_to: str | None = None):
    params: list[object] = []
    where = ["p.status='active'", "t.status='published'"]
    placeholders = ",".join("?" for _ in targets)
    where.append(f"t.target IN ({placeholders})")
    params.extend(targets)
    if refs:
        ref_placeholders = ",".join("?" for _ in refs)
        where.append(f"p.post_key IN ({ref_placeholders})")
        params.extend(refs)
    if date_from:
        where.append("p.date_utc >= ?")
        params.append(date_from)
    if date_to:
        where.append("p.date_utc <= ?")
        params.append(date_to)
    rows = conn.execute(
        f"""
        SELECT p.post_key, p.post_id, p.message_id, p.date_utc, t.target
        FROM posts p
        JOIN post_targets t ON t.post_key = p.post_key
        WHERE {" AND ".join(where)}
        ORDER BY p.date_utc DESC, t.target
        """,
        tuple(params),
    ).fetchall()
    return [dict(row) for row in rows]


def apply_backfill_plan(conn, rows, reset_counts: bool = False) -> int:
    now = iso_utc(utc_now_dt())
    for row in rows:
        if reset_counts:
            conn.execute(
                """
                INSERT INTO metric_schedule(post_key, target, next_check_at, check_count, frozen_at, updated_at)
                VALUES (?, ?, NULL, 0, NULL, ?)
                ON CONFLICT(post_key, target) DO UPDATE SET
                    next_check_at=NULL,
                    check_count=0,
                    frozen_at=NULL,
                    last_error=NULL,
                    updated_at=excluded.updated_at
                """,
                (row["post_key"], row["target"], now),
            )
        else:
            conn.execute(
                """
                INSERT INTO metric_schedule(post_key, target, next_check_at, frozen_at, updated_at)
                VALUES (?, ?, NULL, NULL, ?)
                ON CONFLICT(post_key, target) DO UPDATE SET
                    next_check_at=NULL,
                    frozen_at=NULL,
                    last_error=NULL,
                    updated_at=excluded.updated_at
                """,
                (row["post_key"], row["target"], now),
            )
    conn.execute(
        "UPDATE metric_schedule SET frozen_at=?, next_check_at=NULL, updated_at=? WHERE target IN (?, ?)",
        (now, now, *UNSUPPORTED_METRIC_TARGETS),
    )
    conn.commit()
    return len(rows)


def audit_alerts(conn) -> dict:
    rows = conn.execute(
        """
        SELECT severity, event_type, COUNT(*) AS count, MAX(created_at) AS latest
        FROM post_events
        GROUP BY severity, event_type
        ORDER BY severity, event_type
        """
    ).fetchall()
    recent = conn.execute(
        """
        SELECT severity, event_type, target, message, created_at
        FROM post_events
        ORDER BY created_at DESC
        LIMIT 20
        """
    ).fetchall()
    failed_jobs = conn.execute(
        """
        SELECT target, COUNT(*) AS count, MAX(updated_at) AS latest
        FROM publish_jobs
        WHERE status='failed'
        GROUP BY target
        ORDER BY target
        """
    ).fetchall()
    metric_errors = conn.execute(
        """
        SELECT target, COUNT(*) AS count, MAX(updated_at) AS latest
        FROM metric_schedule
        WHERE last_error IS NOT NULL AND last_error != ''
        GROUP BY target
        ORDER BY target
        """
    ).fetchall()
    return {
        "post_events_by_type": [dict(row) for row in rows],
        "recent_post_events": [dict(row) for row in recent],
        "failed_publish_jobs": [dict(row) for row in failed_jobs],
        "metric_schedule_errors": [dict(row) for row in metric_errors],
        "telegram_notifications": "not_audited_in_code",
    }


def active_maintenance_lock(conn) -> dict | None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS maintenance_locks (
            name TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    row = conn.execute(
        "SELECT name, owner, expires_at, created_at FROM maintenance_locks WHERE name=? AND expires_at >= ?",
        (MAINTENANCE_LOCK_NAME, now),
    ).fetchone()
    return dict(row) if row else None


@contextmanager
def maintenance_lock(conn, timeout_seconds: int = 1):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    expires = (now + timedelta(minutes=30)).isoformat()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS maintenance_locks (
            name TEXT PRIMARY KEY,
            owner TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )
    owner = f"{os.uname().nodename}:{os.getpid()}"
    try:
        conn.execute(
            """
            INSERT INTO maintenance_locks(name, owner, expires_at, created_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                owner=CASE WHEN maintenance_locks.expires_at < ? THEN excluded.owner ELSE maintenance_locks.owner END,
                expires_at=CASE WHEN maintenance_locks.expires_at < ? THEN excluded.expires_at ELSE maintenance_locks.expires_at END,
                created_at=CASE WHEN maintenance_locks.expires_at < ? THEN excluded.created_at ELSE maintenance_locks.created_at END
            """,
            (MAINTENANCE_LOCK_NAME, owner, expires, now.isoformat(), now.isoformat(), now.isoformat(), now.isoformat()),
        )
        row = conn.execute("SELECT owner FROM maintenance_locks WHERE name=?", (MAINTENANCE_LOCK_NAME,)).fetchone()
        if row and row["owner"] != owner:
            raise RuntimeError(f"maintenance lock is held by {row['owner']}")
        conn.commit()
        yield
    finally:
        conn.execute("DELETE FROM maintenance_locks WHERE name=? AND owner=?", (MAINTENANCE_LOCK_NAME, owner))
        conn.commit()


def backup_database(db_path: Path, backup_dir: Path | None = None) -> Path:
    backup_dir = backup_dir or db_path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"{db_path.stem}-{stamp}.db"
    src = sqlite3.connect(str(db_path))
    try:
        dest = sqlite3.connect(str(backup_path))
        try:
            src.backup(dest)
        finally:
            dest.close()
    finally:
        src.close()
    return backup_path
