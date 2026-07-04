from __future__ import annotations

from posting_core.metrics.repository import upsert_post
from posting_core.metrics_config import FEED_JSON, PIPELINE_BASELINE_MESSAGE_ID, load_json


def sync_feed(conn):
    feed = load_json(FEED_JSON, {"items": []})
    count = 0
    for item in feed.get("items", []) or []:
        if int(item.get("message_id") or 0) < PIPELINE_BASELINE_MESSAGE_ID:
            continue
        if upsert_post(conn, item):
            count += 1
    conn.commit()
    return count
