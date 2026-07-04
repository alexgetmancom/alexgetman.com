from __future__ import annotations

import json
from zoneinfo import ZoneInfo

from posting_core.db import connect as db_connect, ensure_pipeline_schema
from posting_core.metrics_config import (
    CHANNEL_USERNAME,
    DB_PATH,
    TARGETS,
    now_iso,
    parse_dt,
    post_key,
)


def connect():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = db_connect(DB_PATH)
    ensure_pipeline_schema(conn)
    return conn


def upsert_post(conn, item):
    post_id = item.get("post_id")
    message_id = item.get("telegram_message_id") or item.get("message_id")
    if not post_id and not message_id:
        return None
    key = f"post:{int(post_id)}" if post_id else post_key(message_id)
    media = item.get("media") or []
    if not media and item.get("image"):
        media = [{"type": "image", "path": item.get("image")}]
    media_types = sorted({m.get("type") for m in media if m.get("type")})
    date_utc = parse_dt(item.get("date"))
    date_msk = date_utc.astimezone(ZoneInfo("Europe/Moscow")).strftime("%Y-%m-%d %H:%M")
    site_ru_path = (
        f"/ru/{int(post_id)}/{item.get('slug_ru') or f'post-{post_id}'}/"
        if post_id and item.get("has_ru")
        else f"/ru/posts/{int(message_id)}/"
        if not post_id
        else None
    )
    site_en_path = (
        f"/{int(post_id)}/{item.get('slug_en') or f'post-{post_id}'}/"
        if post_id and item.get("has_en")
        else f"/en/posts/{int(message_id)}/"
        if not post_id and (item.get("text_en") or item.get("html_en"))
        else None
    )
    existing = conn.execute("SELECT created_at FROM posts WHERE post_key = ?", (key,)).fetchone()
    created_at = existing["created_at"] if existing else now_iso()
    conn.execute(
        """
        INSERT INTO posts (
            post_key, post_id, source, channel, chat_id, message_id, date_utc, date_msk, text, text_en, html, html_en,
            media_json, media_count, media_types_json, site_ru_path, site_en_path, telegram_url,
            status, created_at, updated_at, raw_json
        ) VALUES (?, ?, 'bot', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(post_key) DO UPDATE SET
            chat_id=excluded.chat_id,
            post_id=excluded.post_id,
            date_utc=excluded.date_utc,
            date_msk=excluded.date_msk,
            text=excluded.text,
            text_en=excluded.text_en,
            html=excluded.html,
            html_en=excluded.html_en,
            media_json=excluded.media_json,
            media_count=excluded.media_count,
            media_types_json=excluded.media_types_json,
            site_ru_path=excluded.site_ru_path,
            site_en_path=excluded.site_en_path,
            telegram_url=excluded.telegram_url,
            updated_at=excluded.updated_at,
            raw_json=excluded.raw_json
        """,
        (
            key,
            int(post_id) if post_id else None,
            CHANNEL_USERNAME,
            str(item.get("chat_id") or ""),
            int(message_id or -int(post_id)),
            date_utc.isoformat(),
            date_msk,
            item.get("text"),
            item.get("text_en"),
            item.get("html"),
            item.get("html_en"),
            json.dumps(media, ensure_ascii=False),
            len(media),
            json.dumps(media_types, ensure_ascii=False),
            site_ru_path,
            site_en_path,
            item.get("url"),
            created_at,
            now_iso(),
            json.dumps(item, ensure_ascii=False),
        ),
    )
    for target in TARGETS:
        selected = (item.get("targets") or {}).get(target)
        status = "published" if selected and target in ("telegram", "site_ru", "site_en") else "unknown"
        url = None
        if target == "telegram":
            url = item.get("url")
        elif target == "site_ru":
            url = site_ru_path
        elif target == "site_en" and site_en_path:
            status = "published"
            url = site_en_path
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, url, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(post_key, target) DO UPDATE SET
                status = CASE WHEN post_targets.status IN ('published','failed','skipped') THEN post_targets.status ELSE excluded.status END,
                url = COALESCE(post_targets.url, excluded.url),
                updated_at = excluded.updated_at
            """,
            (key, target, status, url, now_iso()),
        )
    return key


def metric_value_from_paths(metrics, paths):
    total = 0
    for day in (metrics.get("days") or {}).values():
        if not isinstance(day, dict):
            continue
        day_paths = day.get("paths") or {}
        if not isinstance(day_paths, dict):
            continue
        for path in paths:
            try:
                total += int(day_paths.get(path) or 0)
            except (TypeError, ValueError):
                continue
    return total


def upsert_metric(conn, key, target, value, source, raw=None, error=None, metric_name="views"):
    sampled_at = now_iso()
    raw_json = json.dumps(raw, ensure_ascii=False) if raw is not None else None
    conn.execute(
        """
        INSERT INTO post_metrics(post_key, target, metric_name, value, source, sampled_at, error, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
            value=excluded.value,
            source=excluded.source,
            sampled_at=excluded.sampled_at,
            error=excluded.error,
            raw_json=excluded.raw_json
        """,
        (key, target, metric_name, value, source, sampled_at, error, raw_json),
    )
    if value is not None:
        conn.execute(
            "INSERT INTO metric_samples(post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (key, target, metric_name, int(value), sampled_at, source, raw_json),
        )


def upsert_metrics(conn, key, target, metrics: dict, source, raw=None):
    for metric_name, value in (metrics or {}).items():
        upsert_metric(conn, key, target, int(value), source, raw, metric_name=metric_name)
