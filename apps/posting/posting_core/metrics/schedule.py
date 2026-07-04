from __future__ import annotations

from datetime import timedelta

from posting_core.metrics_config import (
    SCHEDULED_TARGETS,
    MAX_METRIC_TASKS_PER_CYCLE,
    iso_utc,
    metric_interval_for_post,
    parse_iso_dt,
    utc_now_dt,
)


def ensure_metric_schedule(conn):
    now = utc_now_dt()
    placeholders = ",".join("?" for _ in SCHEDULED_TARGETS)
    rows = conn.execute(
        f"""
        SELECT p.post_key, p.date_utc, t.target
        FROM posts p
        JOIN post_targets t ON t.post_key = p.post_key
        WHERE p.status = 'active'
          AND t.status = 'published'
          AND t.target IN ({placeholders})
        """,
        tuple(SCHEDULED_TARGETS),
    ).fetchall()
    for row in rows:
        post_date = parse_iso_dt(row["date_utc"])
        next_check_at = iso_utc(post_date + timedelta(hours=1))
        conn.execute(
            """
            INSERT INTO metric_schedule(post_key, target, next_check_at, frozen_at, updated_at)
            VALUES (?, ?, ?, NULL, ?)
            ON CONFLICT(post_key, target) DO NOTHING
            """,
            (row["post_key"], row["target"], next_check_at, iso_utc(now)),
        )
    conn.commit()


def due_metric_tasks(conn):
    now = iso_utc(utc_now_dt())
    return conn.execute(
        """
        SELECT s.post_key, s.target, s.check_count, p.message_id, p.date_utc,
               t.external_id, t.external_ids_json, t.url
        FROM metric_schedule s
        JOIN posts p ON p.post_key = s.post_key
        JOIN post_targets t ON t.post_key = s.post_key AND t.target = s.target
        WHERE s.frozen_at IS NULL
          AND t.status = 'published'
          AND (s.next_check_at IS NULL OR s.next_check_at <= ?)
        ORDER BY p.date_utc DESC, s.check_count ASC
        LIMIT ?
        """,
        (now, MAX_METRIC_TASKS_PER_CYCLE),
    ).fetchall()


def finish_metric_task(conn, post_key, target, post_date_utc, error=None):
    now = utc_now_dt()
    row = conn.execute("SELECT check_count FROM metric_schedule WHERE post_key=? AND target=?", (post_key, target)).fetchone()
    check_count = row["check_count"] if row else 0
    interval = metric_interval_for_post(post_date_utc, check_count=check_count, now=now)
    frozen_at = iso_utc(now) if interval is None else None
    next_check_at = None if interval is None else iso_utc(now + interval)
    conn.execute(
        """
        INSERT INTO metric_schedule(post_key, target, next_check_at, last_checked_at, check_count, frozen_at, last_error, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(post_key, target) DO UPDATE SET
            next_check_at=excluded.next_check_at,
            last_checked_at=excluded.last_checked_at,
            check_count=metric_schedule.check_count + 1,
            frozen_at=excluded.frozen_at,
            last_error=excluded.last_error,
            updated_at=excluded.updated_at
        """,
        (post_key, target, next_check_at, iso_utc(now), frozen_at, error, iso_utc(now)),
    )
