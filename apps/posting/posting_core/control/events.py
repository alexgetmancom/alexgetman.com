from __future__ import annotations

from posting_core.control.config import json_dumps, now_iso

def emit_event(conn, post_key_value, event_type, message, severity="info", target=None, details=None):
    conn.execute(
        """
        INSERT INTO post_events(post_key, event_type, severity, target, message, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (post_key_value, event_type, severity, target, message, json_dumps(details or {}) if details is not None else None, now_iso()),
    )


def emit_event_once(conn, post_key_value, event_type, message, severity="info", target=None, details=None):
    existing = conn.execute(
        """
        SELECT 1 FROM post_events
        WHERE acked_at IS NULL
          AND event_type=?
          AND message=?
          AND COALESCE(target, '')=COALESCE(?, '')
          AND COALESCE(post_key, '')=COALESCE(?, '')
        LIMIT 1
        """,
        (event_type, message, target, post_key_value),
    ).fetchone()
    if existing:
        return
    emit_event(conn, post_key_value, event_type, message, severity=severity, target=target, details=details)
