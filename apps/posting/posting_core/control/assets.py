from __future__ import annotations

import hashlib
import json
from pathlib import Path

from posting_core.control.config import json_dumps, log, now_iso

def asset_hash(file_id, post_key_value, locale, idx):
    return hashlib.sha256(f"{post_key_value}:{locale}:{idx}:{file_id}".encode("utf-8")).hexdigest()


def local_file_fingerprint(source_path):
    if not source_path:
        return None, None
    try:
        path = Path(source_path)
        if not path.is_absolute() or not path.is_file():
            return None, None
        digest = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest(), path.stat().st_size
    except Exception as exc:
        log(f"Cannot fingerprint media asset {source_path}: {exc}")
        return None, None


def upsert_asset(conn, post, item, locale, role, idx, draft_id=None):
    key = post["post_key"]
    file_id = item.get("file_id") or item.get("path") or item.get("url") or f"{key}:{locale}:{idx}"
    asset_key = asset_hash(str(file_id), key, locale, idx)
    media_type = item.get("type") or item.get("media_type")
    public_url = item.get("url") or item.get("public_url")
    source_path = item.get("path") or item.get("local_path")
    sha256, size_bytes = local_file_fingerprint(source_path)
    conn.execute(
        """
        INSERT INTO media_assets(asset_key, post_key, draft_id, locale, role, media_type, file_id, source_path, public_url, sha256, size_bytes, status, details_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'known', ?, ?, ?)
        ON CONFLICT(asset_key) DO UPDATE SET
            post_key=excluded.post_key,
            draft_id=excluded.draft_id,
            locale=excluded.locale,
            role=excluded.role,
            media_type=excluded.media_type,
            file_id=excluded.file_id,
            source_path=excluded.source_path,
            public_url=excluded.public_url,
            sha256=COALESCE(excluded.sha256, media_assets.sha256),
            size_bytes=COALESCE(excluded.size_bytes, media_assets.size_bytes),
            details_json=excluded.details_json,
            updated_at=excluded.updated_at
        """,
        (asset_key, key, draft_id, locale, role, media_type, file_id, source_path, public_url, sha256, size_bytes, json_dumps(item), now_iso(), now_iso()),
    )


def sync_media_assets(conn):
    site_source = {}
    has_site_source_items = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_source_items'"
    ).fetchone()
    if has_site_source_items:
        rows = conn.execute("SELECT message_id, item_json FROM site_source_items").fetchall()
        for row in rows:
            try:
                item = json.loads(row["item_json"] or "{}")
            except Exception:
                item = {}
            if isinstance(item, dict):
                site_source[str(row["message_id"])] = item
    posts = conn.execute("SELECT * FROM posts ORDER BY message_id DESC").fetchall()
    for post in posts:
        try:
            media = json.loads(post["media_json"] or "[]")
        except Exception:
            media = []
        for idx, item in enumerate(media):
            upsert_asset(conn, post, item, "ru", "original", idx)
        source = site_source.get(str(post["message_id"])) if isinstance(site_source, dict) else None
        if isinstance(source, dict):
            draft_id = source.get("draft_id")
            for locale, key_name in (("ru", "media_ru"), ("en", "media_en")):
                source_media = source.get(key_name) or []
                if isinstance(source_media, dict):
                    source_media = [source_media]
                for idx, item in enumerate(source_media):
                    upsert_asset(conn, post, item, locale, "approved", idx, draft_id=draft_id)
    conn.commit()
