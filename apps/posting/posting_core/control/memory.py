from __future__ import annotations

import json
import re

from posting_core.control.config import json_dumps, now_iso, safe_int
from posting_core.control.lifecycle import infer_format

def extract_urls(text):
    return re.findall(r"https?://[^\s)]+", text or "")


def extract_topics(text):
    text = text or ""
    known = ["Codex", "OpenAI", "ChatGPT", "Claude", "DeepSeek", "Google", "Meta", "LinkedIn", "Threads", "Telegram", "Midjourney", "AI", "ИИ"]
    return sorted({topic for topic in known if topic.lower() in text.lower()})


def sync_content_memory(conn):
    rows = conn.execute("SELECT * FROM posts ORDER BY message_id DESC").fetchall()
    for row in rows:
        text_ru = row["text"] or ""
        text_en = row["text_en"] or ""
        merged = "\n".join(x for x in (text_ru, text_en) if x)
        title = (text_en or text_ru).strip().splitlines()[0][:120] if (text_en or text_ru).strip() else f"Post {row['message_id']}"
        summary = " ".join((text_en or text_ru).split()[:40])
        topics = extract_topics(merged)
        urls = extract_urls(merged)
        metrics = {}
        for metric in conn.execute("SELECT target, metric_name, value FROM post_metrics WHERE post_key=?", (row["post_key"],)).fetchall():
            metrics.setdefault(metric["target"], {})[metric["metric_name"]] = metric["value"]
        conn.execute(
            """
            INSERT INTO content_memory(post_key, message_id, lang, title, summary, topics_json, entities_json, source_urls_json, performance_json, created_at, updated_at)
            VALUES (?, ?, 'mixed', ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(post_key) DO UPDATE SET
                title=excluded.title,
                summary=excluded.summary,
                topics_json=excluded.topics_json,
                entities_json=excluded.entities_json,
                source_urls_json=excluded.source_urls_json,
                performance_json=excluded.performance_json,
                updated_at=excluded.updated_at
            """,
            (row["post_key"], row["message_id"], title, summary, json_dumps(topics), json_dumps(topics), json_dumps(urls), json_dumps(metrics), now_iso(), now_iso()),
        )
    conn.commit()


def sync_analytics(conn):
    target_rows = conn.execute(
        """
        SELECT t.target, COUNT(*) AS posts,
               SUM(CASE WHEN t.status='published' THEN 1 ELSE 0 END) AS published,
               SUM(CASE WHEN t.status='failed' THEN 1 ELSE 0 END) AS failed
        FROM post_targets t
        GROUP BY t.target
        """
    ).fetchall()
    for row in target_rows:
        metrics = {"posts": row["posts"], "published": row["published"], "failed": row["failed"]}
        views = conn.execute(
            "SELECT SUM(value) AS views FROM post_metrics WHERE target=? AND metric_name='views'",
            (row["target"],),
        ).fetchone()["views"]
        metrics["views"] = safe_int(views)
        conn.execute(
            """
            INSERT INTO analytics_rollups(rollup_key, scope, subject, metric_json, updated_at)
            VALUES (?, 'target', ?, ?, ?)
            ON CONFLICT(rollup_key) DO UPDATE SET metric_json=excluded.metric_json, updated_at=excluded.updated_at
            """,
            (f"target:{row['target']}", row["target"], json_dumps(metrics), now_iso()),
        )

    format_rows = conn.execute("SELECT post_key, media_types_json, media_count FROM posts").fetchall()
    format_counts = {}
    for row in format_rows:
        try:
            media_types = json.loads(row["media_types_json"] or "[]")
        except Exception:
            media_types = []
        format_key = infer_format([{"type": media_type} for media_type in media_types for _ in range(max(1, safe_int(row["media_count"], 1)))])
        format_counts[format_key] = format_counts.get(format_key, 0) + 1
    for format_key, count in format_counts.items():
        conn.execute(
            """
            INSERT INTO analytics_rollups(rollup_key, scope, subject, metric_json, updated_at)
            VALUES (?, 'format', ?, ?, ?)
            ON CONFLICT(rollup_key) DO UPDATE SET metric_json=excluded.metric_json, updated_at=excluded.updated_at
            """,
            (f"format:{format_key}", format_key, json_dumps({"posts": count}), now_iso()),
        )
    conn.commit()
