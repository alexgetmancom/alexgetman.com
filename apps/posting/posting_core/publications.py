from __future__ import annotations

import json
from typing import Any

from posting_core.content import entities_to_html, parse_entities, slugify
from posting_core.db import connect, ensure_pipeline_schema, now_iso
from posting_core.paths import PostingPaths, get_paths


def ensure_publication(draft_id: int, paths: PostingPaths | None = None) -> int:
    paths = paths or get_paths()
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        row = conn.execute(
            "SELECT post_id FROM publications WHERE draft_id=?",
            (int(draft_id),),
        ).fetchone()
        if row:
            return int(row["post_id"])
        now = now_iso()
        cur = conn.execute(
            """
            INSERT INTO publications(draft_id, status, created_at, updated_at)
            VALUES (?, 'approved', ?, ?)
            """,
            (int(draft_id), now, now),
        )
        post_id = int(cur.lastrowid)
        conn.execute("UPDATE drafts SET post_id=?, updated_at=? WHERE id=?", (post_id, now, int(draft_id)))
        conn.commit()
        return post_id


def sync_publication_from_draft(
    draft: dict[str, Any],
    targets: dict[str, bool],
    paths: PostingPaths | None = None,
) -> int:
    paths = paths or get_paths()
    post_id = int(draft.get("post_id") or ensure_publication(int(draft["id"]), paths))
    values = {
        "ru": (
            draft.get("text_ru") or "",
            draft.get("text_ru_entities_json"),
            draft.get("media_ru_json"),
            bool(targets.get("site_ru")),
        ),
        "en": (
            draft.get("text_en_approved") or draft.get("text_en_machine") or "",
            draft.get("text_en_entities_json"),
            draft.get("media_en_json") or draft.get("media_ru_json"),
            bool(targets.get("site_en")),
        ),
    }
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        for locale, (text, entities_json, media_json, enabled) in values.items():
            if not text and not media_json and not enabled:
                continue
            entities = parse_entities(entities_json)
            slug = slugify(text, locale, fallback=f"post-{post_id}")
            conn.execute(
                """
                INSERT INTO post_locales(
                    post_id, locale, slug, text, html, entities_json, media_json,
                    site_enabled, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(post_id, locale) DO UPDATE SET
                    text=excluded.text,
                    html=excluded.html,
                    entities_json=excluded.entities_json,
                    media_json=excluded.media_json,
                    site_enabled=excluded.site_enabled,
                    updated_at=excluded.updated_at
                """,
                (
                    post_id,
                    locale,
                    slug,
                    text,
                    entities_to_html(text, entities),
                    json.dumps(entities, ensure_ascii=False),
                    media_json,
                    int(enabled),
                    now_iso(),
                ),
            )
        conn.commit()
    return post_id


def post_key(post_id: int) -> str:
    return f"post:{int(post_id)}"


def release_unpublished_publication(
    post_id: int,
    paths: PostingPaths | None = None,
) -> None:
    paths = paths or get_paths()
    post_id = int(post_id)
    with connect(paths.pipeline_db) as conn:
        ensure_pipeline_schema(conn)
        published = conn.execute(
            """
            SELECT 1 FROM post_targets
            WHERE post_key=? AND status IN ('publishing', 'published', 'skipped')
            LIMIT 1
            """,
            (post_key(post_id),),
        ).fetchone()
        if published:
            return
        conn.execute("DELETE FROM publication_plans WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM publication_sources WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM post_locales WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM publications WHERE post_id=?", (post_id,))
        conn.execute("UPDATE drafts SET post_id=NULL WHERE post_id=?", (post_id,))
        max_row = conn.execute("SELECT MAX(post_id) AS max_id FROM publications").fetchone()
        max_id = int(max_row["max_id"] or 0)
        conn.execute(
            "UPDATE sqlite_sequence SET seq=? WHERE name='publications'",
            (max_id,),
        )
        conn.commit()
