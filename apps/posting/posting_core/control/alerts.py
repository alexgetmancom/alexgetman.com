from __future__ import annotations

import hashlib
import time
from datetime import datetime, timezone

from posting_core.control.config import (
    ADMIN_IDS,
    ALERT_COOLDOWN_SECONDS,
    COMMAND_CENTER_URL,
    CONTROLLER_BOT_TOKEN,
    QUEUE_STALE_SECONDS,
    now_iso,
    post_key,
)
from posting_core.clients.telegram import call_telegram
from posting_core.control.events import emit_event_once
from posting_core.db import ensure_pipeline_schema

def parse_iso(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def scan_observability(conn):
    ensure_pipeline_schema(conn)
    now = datetime.now(timezone.utc)
    stale_jobs = conn.execute(
        """
        SELECT job_id, message_id, target, publish_at, created_at, locked_at
        FROM publish_jobs
        WHERE status IN ('queued', 'publishing')
          AND (publish_at IS NULL OR publish_at <= ?)
        ORDER BY created_at ASC
        LIMIT 100
        """,
        (now.isoformat(),),
    ).fetchall()
    for job in stale_jobs:
        created = parse_iso(job["locked_at"] or job["publish_at"] or job["created_at"])
        if created and (now - created).total_seconds() > QUEUE_STALE_SECONDS:
            emit_event_once(
                conn,
                post_key(job["message_id"]) if str(job["message_id"]).isdigit() else None,
                "queue.stale",
                f"publish job {job['job_id']} for {job['target']} is stale",
                severity="warn",
                target=job["target"],
                details={"job_id": job["job_id"], "message_id": job["message_id"], "created_at": job["created_at"], "locked_at": job["locked_at"]},
            )

    failed_targets = conn.execute(
        """
        SELECT p.post_key, p.message_id, t.target, t.error
        FROM post_targets t
        JOIN posts p ON p.post_key=t.post_key
        WHERE t.status='failed'
        ORDER BY t.updated_at DESC
        LIMIT 30
        """
    ).fetchall()
    for row in failed_targets:
        emit_event_once(
            conn,
            row["post_key"],
            "target.failed",
            f"post {row['message_id']} failed on {row['target']}",
            severity="error",
            target=row["target"],
            details={"error": row["error"]},
        )
    conn.commit()


def send_alerts(conn):
    if not CONTROLLER_BOT_TOKEN or not ADMIN_IDS:
        return 0
    ensure_pipeline_schema(conn)
    rows = conn.execute(
        "SELECT * FROM post_events WHERE acked_at IS NULL AND severity IN ('warn','error') ORDER BY created_at ASC LIMIT 10"
    ).fetchall()
    if not rows:
        return 0
    now = now_iso()
    now_ts = time.time()
    send_rows = []
    suppressed_ids = []
    seen_keys = set()
    for row in rows:
        alert_key = hashlib.sha256(f"{row['severity']}|{row['target'] or ''}|{row['message']}".encode("utf-8")).hexdigest()
        dedup = conn.execute("SELECT last_sent_at, suppressed_count FROM alert_dedup WHERE alert_key=?", (alert_key,)).fetchone()
        last_sent_ts = 0.0
        if dedup and dedup["last_sent_at"]:
            try:
                last_sent_ts = datetime.fromisoformat(dedup["last_sent_at"]).timestamp()
            except Exception:
                last_sent_ts = 0.0
        if alert_key in seen_keys or (dedup and now_ts - last_sent_ts < ALERT_COOLDOWN_SECONDS):
            suppressed_ids.append(row["id"])
            conn.execute(
                """
                INSERT INTO alert_dedup(alert_key, last_sent_at, suppressed_count)
                VALUES (?, ?, 1)
                ON CONFLICT(alert_key) DO UPDATE SET suppressed_count=suppressed_count+1
                """,
                (alert_key, now),
            )
            continue
        send_rows.append((row, alert_key))
        seen_keys.add(alert_key)
    if suppressed_ids:
        conn.executemany("UPDATE post_events SET acked_at=? WHERE id=?", [(now, row_id) for row_id in suppressed_ids])
    if not send_rows:
        conn.commit()
        return 0
    lines = ["AlexGetman posting alerts", ""]
    for row, _ in send_rows:
        target = f" [{row['target']}]" if row["target"] else ""
        lines.append(f"- {row['severity'].upper()}{target}: {row['message']}")
    lines.extend(["", COMMAND_CENTER_URL])
    text = "\n".join(lines)
    for admin_id in ADMIN_IDS:
        call_telegram("sendMessage", {"chat_id": admin_id, "text": text, "disable_web_page_preview": True}, token=CONTROLLER_BOT_TOKEN)
    conn.executemany("UPDATE post_events SET acked_at=? WHERE id=?", [(now, row["id"]) for row, _ in send_rows])
    conn.executemany(
        """
        INSERT INTO alert_dedup(alert_key, last_sent_at, suppressed_count)
        VALUES (?, ?, 0)
        ON CONFLICT(alert_key) DO UPDATE SET last_sent_at=excluded.last_sent_at
        """,
        [(alert_key, now) for _, alert_key in send_rows],
    )
    conn.commit()
    return len(send_rows)
