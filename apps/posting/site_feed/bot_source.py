from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from posting_core.db import connect, ensure_pipeline_schema
from posting_core.text import clean_text
from posting_core.time_utils import now_iso
from site_feed.config import PIPELINE_DB, PUBLIC_MEDIA_DIR, SOURCE_MEDIA_DIR, log
from site_feed.feed_store import load_feed, save_feed
from site_feed.render import request_render
from site_feed.telegram import download_media, download_telegram_media, text_to_html


def video_poster_path(media_path):
    if not media_path:
        return None
    relative_path = str(media_path).lstrip("/")
    if not relative_path.startswith("media/"):
        return None
    source_path = SOURCE_MEDIA_DIR / Path(relative_path).name
    if not source_path.exists():
        source_path = PUBLIC_MEDIA_DIR / Path(relative_path).name
    if not source_path.exists():
        return None

    poster_name = f"{source_path.stem}-poster.jpg"
    source_poster = SOURCE_MEDIA_DIR / poster_name
    public_poster = PUBLIC_MEDIA_DIR / poster_name
    if public_poster.exists():
        return f"media/{poster_name}"

    try:
        SOURCE_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        PUBLIC_MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [
            "ffmpeg",
            "-y",
            "-ss",
            "0.5",
            "-i",
            str(source_path),
            "-frames:v",
            "1",
            "-q:v",
            "3",
            str(source_poster),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if res.returncode != 0:
            log(f"Ошибка генерации poster для {media_path}: {res.stderr[-1000:]}")
            return None
        public_poster.write_bytes(source_poster.read_bytes())
        source_poster.chmod(0o664)
        public_poster.chmod(0o664)
        return f"media/{poster_name}"
    except Exception as exc:
        log(f"Ошибка генерации poster для {media_path}: {exc}")
    return None

def bot_source_to_item(source):
    post_id = int(source.get("post_id") or 0)
    if not post_id:
        return None
    targets = source.get("targets") if isinstance(source.get("targets"), dict) else {}
    locales = source.get("locales") if isinstance(source.get("locales"), dict) else {}
    ru = locales.get("ru") or {}
    en = locales.get("en") or {}
    now = datetime.now(timezone.utc)

    def is_due(value):
        if not value:
            return True
        try:
            return datetime.fromisoformat(value) <= now
        except (TypeError, ValueError):
            return True

    publish_at_ru = source.get("publish_at_ru")
    publish_at_en = source.get("publish_at_en")
    ru_due = is_due(publish_at_ru)
    en_due = is_due(publish_at_en)
    text_ru = clean_text(ru.get("text") or source.get("text_ru") or "") if targets.get("site_ru") and ru_due else ""
    text_en = clean_text(en.get("text") or source.get("text_en") or "") if en_due and targets.get("site_en") else ""
    controller_token = os.environ.get("CONTROLLER_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")

    def existing_media_path(filename_prefix, suffix, index=0):
        target_name = f"{filename_prefix}.{suffix}" if int(index or 0) == 0 else f"{filename_prefix}-{int(index)}.{suffix}"
        for base_dir in (SOURCE_MEDIA_DIR, PUBLIC_MEDIA_DIR):
            if (base_dir / target_name).exists():
                return f"media/{target_name}"
        return None

    def download_source_media(source_key, filename_prefix):
        media_source = source.get(source_key)
        media_items = media_source if isinstance(media_source, list) else ([media_source] if isinstance(media_source, dict) else [])
        downloaded = []
        first_image = None
        for idx, media_item in enumerate(media_items):
            file_id = media_item.get("file_id") if isinstance(media_item, dict) else None
            local_path = (media_item.get("local_path") or media_item.get("path")) if isinstance(media_item, dict) else None
            media_type = media_item.get("type") if isinstance(media_item, dict) else None
            if not file_id and not local_path:
                continue
            normalized_type = "video" if str(media_type).lower() == "video" else "image"
            suffix = "mp4" if normalized_type == "video" else "jpg"
            path = None
            if local_path:
                path = download_media(local_path, filename_prefix, suffix, index=idx)
            if not path and file_id:
                path = download_telegram_media(file_id, filename_prefix, normalized_type, index=idx, token=controller_token)
            if not path:
                path = existing_media_path(filename_prefix, suffix, index=idx)
            if path:
                media_record = {"type": normalized_type, "path": path}
                if normalized_type == "video":
                    poster = video_poster_path(path)
                    if poster:
                        media_record["poster"] = poster
                downloaded.append(media_record)
                if not first_image and normalized_type == "image":
                    first_image = path
        return downloaded, first_image

    has_ru = bool(targets.get("site_ru") and ru_due)
    has_en = bool(targets.get("site_en") and en_due)

    media, image_path = download_source_media("media_ru", post_id) if has_ru else ([], None)
    
    if has_en:
        if source.get("media_en"):
            media_en, image_en = download_source_media("media_en", f"{post_id}-en")
        else:
            media_en, image_en = download_source_media("media_ru", f"{post_id}-en")
    else:
        media_en, image_en = [], None

    if not (has_ru or has_en):
        return None
    item = {
        "id": f"post:{post_id}",
        "source": "bot",
        "post_id": post_id,
        "message_id": source.get("telegram_message_id"),
        "telegram_message_id": source.get("telegram_message_id"),
        "date": source.get("date") or source.get("created_at") or now_iso(),
        "url": source.get("telegram_url"),
        "text": text_ru,
        "html": (ru.get("html") or text_to_html(text_ru)) if has_ru else "",
        "text_en": text_en,
        "html_en": (
            en.get("html") or (text_to_html(text_en) if text_en else "")
        ) if has_en else "",
        "slug_ru": ru.get("slug"),
        "slug_en": en.get("slug"),
        "has_ru": has_ru,
        "has_en": has_en,
        "targets": targets,
        "image": image_path,
        "media": media,
        "edited": False,
        "received_at": now_iso(),
        "publish_at_en": publish_at_en,
        "publish_at_ru": publish_at_ru,
    }
    if media_en:
        item["media_en"] = media_en
    if image_en:
        item["image_en"] = image_en
    return item


def load_bot_sources():
    if not PIPELINE_DB.exists():
        log(f"Pipeline DB не найден: {PIPELINE_DB}")
        return []
    with connect(PIPELINE_DB) as conn:
        ensure_pipeline_schema(conn)
        rows = conn.execute(
            "SELECT post_id, item_json FROM publication_sources ORDER BY post_id"
        ).fetchall()
        locale_rows = conn.execute(
            "SELECT post_id, locale, slug, text, html, media_json, site_enabled FROM post_locales"
        ).fetchall()
    locales_by_post = {}
    for row in locale_rows:
        locales_by_post.setdefault(int(row["post_id"]), {})[row["locale"]] = dict(row)
    sources = []
    for row in rows:
        try:
            item = json.loads(row["item_json"] or "{}")
        except Exception:
            item = {}
        if isinstance(item, dict):
            item["post_id"] = int(row["post_id"])
            item["locales"] = locales_by_post.get(int(row["post_id"]), {})
            sources.append(item)
    return sources


def sync_bot_source():
    items = []
    for source in load_bot_sources():
        item = bot_source_to_item(source)
        if item:
            items.append(item)
    if not items:
        save_feed([])
        log("Canonical source пуст; legacy feed очищен")
        return []
    saved = save_feed(items)
    log(f"Синхронизировано bot-source постов: {len(items)}; в ленте: {len(saved)}")
    return items


def upsert_item(item):
    old_feed = load_feed()
    old_item = next((x for x in old_feed if x.get("id") == item["id"]), None)
    if old_item:
        if old_item.get("text") == item.get("text") and old_item.get("media") == item.get("media"):
            log(f"Пост {item['post_id']} не изменился. Пропускаем сборку.")
            return old_item
        for key in ["text_en", "html_en", "media_en"]:
            if key in old_item and key not in item:
                item[key] = old_item[key]
                
    items = [x for x in old_feed if x.get("id") != item["id"]]
    items.append(item)
    items = save_feed(items)
    request_render(items, post_id=int(item.get("post_id") or 0), reason="webhook")
    return item
