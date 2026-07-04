from __future__ import annotations

from posting_core.control.config import LIFECYCLE_ORDER, json_dumps, now_iso
from posting_core.control.events import emit_event

def set_lifecycle(conn, post_key_value, state, reason=None, raw=None):
    if state not in LIFECYCLE_ORDER:
        state = "publishing"
    ts = now_iso()
    existing = conn.execute("SELECT state FROM post_lifecycle WHERE post_key=?", (post_key_value,)).fetchone()
    previous = existing["state"] if existing else None
    entered_at = ts if previous != state else None
    conn.execute(
        """
        INSERT INTO post_lifecycle(post_key, state, previous_state, entered_at, updated_at, reason, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_key) DO UPDATE SET
            previous_state=CASE WHEN post_lifecycle.state != excluded.state THEN post_lifecycle.state ELSE post_lifecycle.previous_state END,
            state=excluded.state,
            entered_at=CASE WHEN post_lifecycle.state != excluded.state THEN excluded.entered_at ELSE post_lifecycle.entered_at END,
            updated_at=excluded.updated_at,
            reason=excluded.reason,
            raw_json=excluded.raw_json
        """,
        (post_key_value, state, previous, entered_at or ts, ts, reason, json_dumps(raw or {}) if raw is not None else None),
    )
    if previous != state:
        emit_event(conn, post_key_value, "lifecycle.transition", f"{previous or 'new'} -> {state}", details={"reason": reason})


def infer_format(media):
    items = media or []
    if not items:
        return "text_only"
    types = [str(item.get("type") or item.get("media_type") or "").lower() for item in items]
    image_count = sum(1 for item in types if "photo" in item or "image" in item)
    video_count = sum(1 for item in types if "video" in item)
    if image_count and video_count:
        return "mixed_media"
    if video_count > 1:
        return "video_album"
    if video_count == 1:
        return "single_video"
    if image_count > 1:
        return "image_album"
    return "single_image"


def infer_lifecycle(conn, post):
    key = post["post_key"]
    targets = conn.execute("SELECT target, status, error, skipped FROM post_targets WHERE post_key=?", (key,)).fetchall()
    target_map = {row["target"]: row for row in targets}
    active_schedule = conn.execute("SELECT 1 FROM metric_schedule WHERE post_key=? AND frozen_at IS NULL LIMIT 1", (key,)).fetchone()
    frozen_schedule = conn.execute("SELECT 1 FROM metric_schedule WHERE post_key=? AND frozen_at IS NOT NULL LIMIT 1", (key,)).fetchone()
    if post["status"] != "active":
        return "archived", "post_status_not_active"
    if frozen_schedule and not active_schedule:
        return "frozen", "metric_schedule_frozen"
    if active_schedule:
        return "metrics_active", "metric_schedule_active"
    published = [row for row in target_map.values() if row["status"] == "published"]
    failed = [row for row in target_map.values() if row["status"] == "failed"]
    if published and not failed:
        return "published", "targets_published"
    if published or failed:
        return "publishing", "target_status_mixed"
    return "approved", "post_exists_without_targets"


def sync_lifecycle(conn):
    rows = conn.execute("SELECT * FROM posts ORDER BY message_id DESC").fetchall()
    for post in rows:
        state, reason = infer_lifecycle(conn, post)
        set_lifecycle(conn, post["post_key"], state, reason=reason, raw={"message_id": post["message_id"]})
    conn.commit()
