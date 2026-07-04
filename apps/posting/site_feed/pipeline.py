from __future__ import annotations

import html
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from site_feed.feed_store import load_json_file
from site_feed.config import (
    CHANNEL_USERNAME,
    FEED_JSON,
    PIPELINE_DB,
    compact_text,
    log,
    now_iso,
    parse_date,
)
from posting_core.targets import TARGETS
from posting_core.social_urls import target_public_url

def db_rows(path, query, params=()):
    try:
        if not path.exists():
            return []
        conn = sqlite3.connect(str(path), timeout=2)
        conn.row_factory = sqlite3.Row
        try:
            return [dict(row) for row in conn.execute(query, params).fetchall()]
        finally:
            conn.close()
    except Exception as exc:
        log(f"Ошибка чтения pipeline db: {exc}")
        return []


def load_pipeline_db_posts(limit=30):
    try:
        import sqlite3
        if not PIPELINE_DB.exists():
            return {}
        conn = sqlite3.connect(str(PIPELINE_DB), timeout=2)
        conn.row_factory = sqlite3.Row
        try:
            posts = {}
            for row in conn.execute(
                """
                SELECT post_key, message_id, date_utc, date_msk, text, text_en, media_count, media_types_json,
                       site_ru_path, site_en_path, telegram_url
                FROM posts
                WHERE status = 'active'
                ORDER BY message_id DESC
                LIMIT ?
                """,
                (limit,),
            ):
                key = row["post_key"]
                try:
                    media_types = json.loads(row["media_types_json"] or "[]")
                except Exception:
                    media_types = []
                posts[key] = {
                    "post_key": key,
                    "message_id": row["message_id"],
                    "date": row["date_utc"],
                    "date_msk": row["date_msk"],
                    "text": row["text"],
                    "text_en": row["text_en"],
                    "media_count": row["media_count"],
                    "media_types": media_types,
                    "site_url": row["site_ru_path"],
                    "telegram_url": row["telegram_url"],
                    "targets": {},
                    "metrics": {},
                }
            if not posts:
                return {}
            placeholders = ",".join("?" for _ in posts)
            for row in conn.execute(
                f"SELECT post_key, target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json FROM post_targets WHERE post_key IN ({placeholders})",
                tuple(posts.keys()),
            ):
                posts[row["post_key"]]["targets"][row["target"]] = {
                    "status": row["status"],
                    "ok": row["status"] == "published",
                    "external_id": row["external_id"],
                    "external_ids": json.loads(row["external_ids_json"] or "[]") if row["external_ids_json"] else [],
                    "url": row["url"],
                    "error": row["error"],
                    "skipped": bool(row["skipped"]),
                    "updated_at": row["updated_at"],
                    "raw": json.loads(row["raw_json"] or "{}") if row["raw_json"] else {},
                }
            for row in conn.execute(
                f"SELECT post_key, target, metric_name, value, sampled_at, source, error, raw_json FROM post_metrics WHERE post_key IN ({placeholders})",
                tuple(posts.keys()),
            ):
                posts[row["post_key"]]["metrics"].setdefault(row["target"], {})[row["metric_name"]] = {
                    "value": row["value"],
                    "sampled_at": row["sampled_at"],
                    "source": row["source"],
                    "error": row["error"],
                    "raw": json.loads(row["raw_json"] or "{}") if row["raw_json"] else {},
                }
            return {str(post["message_id"]): post for post in posts.values()}
        finally:
            conn.close()
    except Exception as exc:
        log(f"Ошибка чтения pipeline db: {exc}")
    return {}


def format_pipeline_date(value):
    dt = parse_date(value).astimezone(ZoneInfo("Europe/Moscow"))
    return dt.strftime("%Y-%m-%d %H:%M")


def short_pipeline_text(value, word_limit=7):
    words = compact_text(value).split()
    if len(words) <= word_limit:
        return " ".join(words)
    return " ".join(words[:word_limit]) + "..."


def format_metric_value(value):
    if value is None:
        return ""
    try:
        value = int(value)
    except Exception:
        return ""
    if value >= 1_000_000:
        return f"{value / 1_000_000:.1f}m".replace(".0m", "m")
    if value >= 1_000:
        return f"{value / 1_000:.1f}k".replace(".0k", "k")
    return str(value)


def get_week_bounds(week_offset: int):
    msk_tz = ZoneInfo("Europe/Moscow")
    now_msk = datetime.now(msk_tz)
    current_weekday = now_msk.weekday()
    start_of_current_week = now_msk.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=current_weekday)
    start_of_target_week = start_of_current_week - timedelta(weeks=week_offset)
    end_of_target_week = start_of_target_week + timedelta(days=7) - timedelta(microseconds=1)
    
    start_utc = start_of_target_week.astimezone(timezone.utc)
    end_utc = end_of_target_week.astimezone(timezone.utc)
    return start_of_target_week, end_of_target_week, start_utc, end_utc


def target_url(post, target):
    targets = post.get("targets") or {}
    record = targets.get(target) or {}
    url = record.get("url")
    external_id = record.get("external_id")
    if url:
        return url.replace("threads.net", "threads.com")
    if target == "telegram":
        return post.get("telegram_url")
    if target == "site_ru":
        return post.get("site_url")
    if target == "site_en":
        slug_en = post.get("slug_en")
        post_id = post.get("post_id")
        if slug_en and post_id:
            return f"/{post_id}/{slug_en}/"
        return None
    if target == "threads_ru" and external_id:
        return f"https://www.threads.com/@alexgetmanru/post/{external_id}"
    if target == "threads_en" and external_id:
        return f"https://www.threads.com/@alexgetmanco/post/{external_id}"
    if target == "linkedin" and external_id:
        return "https://www.linkedin.com/feed/update/" + external_id
    if target in ("facebook", "facebook_ru") and external_id:
        return "https://www.facebook.com/" + external_id
    if target == "x" and external_id:
        return "https://x.com/alexgetmancom/status/" + external_id
    return target_public_url(target, external_id=external_id, url=url)


def get_target_metric(post, target, metric_name: str) -> int:
    """Return numeric value of any metric for a published target, 0 if missing."""
    targets = post.get("targets") or {}
    record = targets.get(target)
    status = record.get("status") if record else None
    if not status:
        if target == "telegram" and post.get("telegram_url"):
            status = "published"
        elif target == "site_ru" and post.get("locales_map", {}).get("ru", {}).get("site_enabled"):
            status = "published"
        elif target == "site_en" and post.get("locales_map", {}).get("en", {}).get("site_enabled"):
            status = "published"
    if status == "published":
        metric = ((post.get("metrics") or {}).get(target) or {}).get(metric_name) or {}
        val = metric.get("value")
        try:
            return int(val) if val is not None else 0
        except (ValueError, TypeError):
            return 0
    return 0


def has_target_metric(post, target, metric_name: str) -> bool:
    if target in ("site_ru", "site_en") and metric_name == "views":
        bot_metric = ((post.get("metrics") or {}).get(target) or {}).get("bot_views")
        if bot_metric and bot_metric.get("value") is not None:
            return True
    metric = ((post.get("metrics") or {}).get(target) or {}).get(metric_name)
    return bool(metric and metric.get("value") is not None)


def target_parts_count(post, target) -> int:
    record = (post.get("targets") or {}).get(target) or {}
    ids = record.get("external_ids") or []
    raw = record.get("raw") or {}
    if not ids and isinstance(raw.get("ids"), list):
        ids = raw.get("ids")
    return len(ids) if len(ids) > 1 else 0


def get_target_views(post, target) -> int:
    return get_target_metric(post, target, "views")



def _fmt(val: int) -> str:
    return format_metric_value(val) if val > 0 else "0"


def _dash_or(val: int) -> str:
    """Show value or dash when metric is not meaningful (0 = no data)."""
    return _fmt(val) if val > 0 else "—"


def target_cell(post, target):
    targets = post.get("targets") or {}
    record = targets.get(target)
    status = record.get("status") if record else None
    if not status:
        if target == "telegram" and post.get("telegram_url"):
            status = "published"
        elif target == "site_ru" and post.get("locales_map", {}).get("ru", {}).get("site_enabled"):
            status = "published"
        elif target == "site_en" and post.get("locales_map", {}).get("en", {}).get("site_enabled"):
            status = "published"
    if status == "published":
        views   = get_target_metric(post, target, "views")
        if target in ("site_ru", "site_en"):
            views += get_target_metric(post, target, "bot_views")
        likes   = get_target_metric(post, target, "likes")
        replies = get_target_metric(post, target, "replies")
        reposts = get_target_metric(post, target, "reposts")
        url = target_url(post, target)
        def _cell(metric_val, label, metric_name):
            if not has_target_metric(post, target, metric_name):
                text = "—"
            else:
                text = _fmt(metric_val) if metric_val > 0 else "0"
            if url and label == "mv":
                return f'<a class="metric-link" href="{html.escape(url, quote=True)}" target="_blank" rel="noopener noreferrer"><span class="{label}">{html.escape(text)}</span></a>'
            return f'<span class="{label}">{html.escape(text)}</span>'
        return (
            _cell(views,   "mv", "views") +
            _cell(likes,   "ml", "likes") +
            _cell(replies, "mr", "replies") +
            _cell(reposts, "mp", "reposts")
        )
    elif status in ("publishing", "queued"):
        return '<span class="mv">~</span><span class="ml">~</span><span class="mr">~</span><span class="mp">~</span>'
    else:
        return '<span class="mv">—</span><span class="ml">—</span><span class="mr">—</span><span class="mp">—</span>'


def load_pipeline_publications(limit=30, week_offset: int = 0):
    try:
        if not PIPELINE_DB.exists():
            return []
        conn = sqlite3.connect(str(PIPELINE_DB), timeout=2)
        conn.row_factory = sqlite3.Row
        try:
            start_of_week, end_of_week, start_utc, end_utc = get_week_bounds(week_offset)
            pubs = conn.execute(
                """
                SELECT
                    post_id,
                    draft_id,
                    telegram_message_id,
                    created_at,
                    updated_at,
                    NULL AS text_ru,
                    NULL AS text_en,
                    NULL AS media_json
                FROM publications
                WHERE created_at >= ? AND created_at <= ?

                UNION ALL

                SELECT
                    NULL AS post_id,
                    NULL AS draft_id,
                    message_id AS telegram_message_id,
                    date_utc AS created_at,
                    updated_at,
                    text AS text_ru,
                    text_en AS text_en,
                    media_json AS media_json
                FROM posts
                WHERE post_key LIKE 'telegram:%'
                  AND date_utc >= ? AND date_utc <= ?

                ORDER BY created_at DESC
                """,
                (
                    start_utc.isoformat(), end_utc.isoformat(),
                    start_utc.isoformat(), end_utc.isoformat(),
                ),
            ).fetchall()
            
            posts = []
            for pub in pubs:
                post_id = pub["post_id"]
                telegram_message_id = pub["telegram_message_id"]
                
                if post_id:
                    pkey = f"post:{post_id}"
                else:
                    pkey = f"telegram:alexgetmancom:{telegram_message_id}"
                
                if post_id:
                    locales = conn.execute(
                        "SELECT locale, text, html, media_json, site_enabled, slug FROM post_locales WHERE post_id=?",
                        (post_id,),
                    ).fetchall()
                    
                    locales_map = {row["locale"]: row for row in locales}
                    ru_loc = locales_map.get("ru")
                    en_loc = locales_map.get("en")
                    
                    text_ru = ru_loc["text"] if ru_loc else ""
                    text_en = en_loc["text"] if en_loc else ""
                    media_ru = json.loads(ru_loc["media_json"] or "[]") if ru_loc and ru_loc["media_json"] else []
                    media_en = json.loads(en_loc["media_json"] or "[]") if en_loc and en_loc["media_json"] else []
                    media = media_en if media_en else media_ru
                    slug_ru = ru_loc["slug"] if ru_loc else f"post-{post_id}"
                    slug_en = en_loc["slug"] if en_loc else None
                    site_enabled_ru = bool(ru_loc["site_enabled"]) if ru_loc else False
                    site_enabled_en = bool(en_loc["site_enabled"]) if en_loc else False
                    
                    locales_dict = {loc["locale"]: {"site_enabled": loc["site_enabled"]} for loc in locales}
                else:
                    text_ru = pub["text_ru"] or ""
                    text_en = pub["text_en"] or ""
                    try:
                        media = json.loads(pub["media_json"] or "[]")
                    except Exception:
                        media = []
                    slug_ru = f"post-{telegram_message_id}"
                    slug_en = None
                    site_enabled_ru = False
                    site_enabled_en = False
                    
                targets = {}
                rows = conn.execute(
                    "SELECT target, status, external_id, external_ids_json, url, error, skipped, updated_at, raw_json FROM post_targets WHERE post_key=?",
                    (pkey,),
                ).fetchall()
                for row in rows:
                    targets[row["target"]] = {
                        "status": row["status"],
                        "ok": row["status"] == "published",
                        "external_id": row["external_id"],
                        "external_ids": json.loads(row["external_ids_json"] or "[]") if row["external_ids_json"] else [],
                        "url": row["url"],
                        "error": row["error"],
                        "skipped": bool(row["skipped"]),
                        "updated_at": row["updated_at"],
                        "raw": json.loads(row["raw_json"] or "{}") if row["raw_json"] else {},
                    }
                    if not post_id:
                        if row["target"] == "site_ru" and row["status"] == "published":
                            site_enabled_ru = True
                        if row["target"] == "site_en" and row["status"] == "published":
                            site_enabled_en = True
                
                if not post_id:
                    locales_dict = {
                        "ru": {"site_enabled": site_enabled_ru},
                        "en": {"site_enabled": site_enabled_en}
                    }

                metrics = {}
                rows = conn.execute(
                    "SELECT target, metric_name, value, sampled_at, source, error, raw_json FROM post_metrics WHERE post_key=?",
                    (pkey,),
                ).fetchall()
                for row in rows:
                    metrics.setdefault(row["target"], {})[row["metric_name"]] = {
                        "value": row["value"],
                        "sampled_at": row["sampled_at"],
                        "source": row["source"],
                        "error": row["error"],
                        "raw": json.loads(row["raw_json"] or "{}") if row["raw_json"] else {},
                    }
                
                display_id = post_id
                
                if site_enabled_ru:
                    site_url = f"/ru/{post_id}/{slug_ru}/"
                elif site_enabled_en and slug_en:
                    site_url = f"/{post_id}/{slug_en}/"
                else:
                    site_url = None
                
                posts.append({
                    "post_id": post_id,
                    "message_id": display_id,
                    "telegram_message_id": telegram_message_id,
                    "date": pub["created_at"],
                    "date_msk": format_pipeline_date(pub["created_at"]),
                    "text_ru": short_pipeline_text(text_ru),
                    "text_en": short_pipeline_text(text_en),
                    "full_text_ru": text_ru,
                    "full_text_en": text_en,
                    "text": short_pipeline_text(text_ru),
                    "media_count": len(media),
                    "media_types": sorted({m.get("type") for m in media if m.get("type")}),
                    "slug_en": slug_en,
                    "site_url": site_url,
                    "telegram_url": f"https://t.me/{CHANNEL_USERNAME}/{telegram_message_id}" if telegram_message_id else None,
                    "targets": targets,
                    "metrics": metrics,
                    "locales_map": locales_dict,
                })
            return posts
        finally:
            conn.close()
    except Exception as exc:
        log(f"Ошибка чтения pipeline db: {exc}")
    return []


def pipeline_status_payload(week_offset: int = 0):
    feed = load_json_file(FEED_JSON, {"items": [], "updated_at": None, "channel": CHANNEL_USERNAME})
    feed_items = feed.get("items") if isinstance(feed, dict) else []
    worker_state = db_rows(PIPELINE_DB, "SELECT state_json FROM worker_state WHERE name='telegram_to_threads'")
    try:
        state = json.loads(worker_state[0].get("state_json") or "{}") if worker_state else {}
    except Exception:
        state = {}
    processed = set(str(x) for x in state.get("processed_message_ids", []))

    posts = load_pipeline_publications(week_offset=week_offset)
    for post in posts:
        targets = post["targets"]
        locales_map = post.get("locales_map") or {}

        def target_ok(name, fallback=False):
            record = targets.get(name)
            if record and record.get("status") != "unknown":
                return bool(record.get("ok"))
            return bool(fallback)

        for target in TARGETS:
            fallback = False
            if target.id == "telegram":
                fallback = bool(post.get("telegram_url"))
            elif target.id == "site_ru":
                fallback = bool(locales_map.get("ru", {}).get("site_enabled"))
            elif target.id == "site_en":
                fallback = bool(locales_map.get("en", {}).get("site_enabled"))
            post[target.id] = target_ok(target.id, fallback)

    return {
        "updated_at": now_iso(),
        "feed": {
            "channel": feed.get("channel") if isinstance(feed, dict) else CHANNEL_USERNAME,
            "updated_at": feed.get("updated_at") if isinstance(feed, dict) else None,
            "items": len(feed_items or []),
        },
        "social_worker": {
            "pipeline_db": str(PIPELINE_DB),
            "last_update_id": state.get("last_update_id"),
            "processed_count": len(processed),
        },
        "posts": posts,
    }
