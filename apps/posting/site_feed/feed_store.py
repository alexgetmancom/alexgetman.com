from __future__ import annotations

import json
from pathlib import Path

from site_feed.config import CHANNEL_USERNAME, FEED_JSON, METRICS_JSON, PIPELINE_DB, atomic_write, log, now_iso

def load_feed():
    if not FEED_JSON.exists():
        return []
    with FEED_JSON.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data.get("items", [])


def save_feed(items):
    deduped = {}
    for item in items:
        deduped[str(item["id"])] = item
    ordered = sorted(deduped.values(), key=lambda x: (x.get("date") or "", int(x.get("message_id") or 0)), reverse=True)
    # Интеграция просмотров Telegram из pipeline.db
    try:
        import sqlite3
        if PIPELINE_DB.exists():
            message_ids = [int(x.get("telegram_message_id") or x.get("message_id") or 0) for x in ordered if x.get("telegram_message_id") or x.get("message_id")]
            if message_ids:
                conn = sqlite3.connect(str(PIPELINE_DB), timeout=2)
                try:
                    placeholders = ",".join("?" for _ in message_ids)
                    query = f"""
                        SELECT p.message_id, m.value 
                        FROM post_metrics m
                        JOIN posts p ON p.post_key = m.post_key
                        WHERE p.message_id IN ({placeholders}) 
                          AND m.target = 'telegram' 
                          AND m.metric_name = 'views'
                    """
                    views_map = {row[0]: row[1] for row in conn.execute(query, message_ids).fetchall()}
                    for item in ordered:
                        msg_id = int(item.get("telegram_message_id") or item.get("message_id") or 0)
                        if msg_id in views_map:
                            try:
                                item["views"] = int(views_map[msg_id])
                            except Exception:
                                item["views"] = 0
                        else:
                            item["views"] = 0
                finally:
                    conn.close()
    except Exception as exc:
        log(f"Ошибка при интеграции просмотров Telegram в feed.json: {exc}")

    payload = {"updated_at": now_iso(), "channel": CHANNEL_USERNAME, "items": ordered}
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    atomic_write(FEED_JSON, text, permissions=0o664)
    from site_feed.render import publish_public_feed
    publish_public_feed(text)
    return ordered


def load_metrics():
    if not METRICS_JSON.exists():
        return {"updated_at": None, "total": 0, "days": {}}
    with METRICS_JSON.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data.get("days"), dict):
        data["days"] = {}
    data["total"] = int(data.get("total") or 0)
    return data


def save_metrics(data):
    data["updated_at"] = now_iso()
    text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    atomic_write(METRICS_JSON, text, permissions=0o664)


def load_json_file(path, fallback):
    try:
        if Path(path).exists():
            return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"Ошибка чтения {path}: {exc}")
    return fallback
