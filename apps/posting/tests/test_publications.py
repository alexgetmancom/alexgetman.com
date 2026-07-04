import sqlite3

from posting_core.content import entities_to_html, slugify
from posting_core.db import ensure_pipeline_schema
from posting_core.paths import PostingPaths
from posting_core.publications import (
    ensure_publication,
    release_unpublished_publication,
    sync_publication_from_draft,
)


def test_first_canonical_publication_is_one_and_locales_are_strict(tmp_path):
    paths = PostingPaths(
        data_dir=tmp_path,
        pipeline_db=tmp_path / "pipeline.db",
        controller_db=tmp_path / "pipeline.db",
    )
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.row_factory = sqlite3.Row
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO drafts(
                id, admin_id, status, text_ru, text_en_approved, targets_json,
                text_ru_entities_json, created_at, updated_at
            )
            VALUES(50, 1, 'needs_review', 'Жирный текст', 'Bold text', '{}',
                   '[{"type":"bold","offset":0,"length":6}]', 'now', 'now')
            """
        )
        conn.commit()

    assert ensure_publication(50, paths) == 1
    draft = {
        "id": 50,
        "post_id": 1,
        "text_ru": "Жирный текст",
        "text_en_approved": "Bold text",
        "text_ru_entities_json": '[{"type":"bold","offset":0,"length":6}]',
        "media_ru_json": None,
        "media_en_json": None,
    }
    sync_publication_from_draft(
        draft,
        {"site_ru": True, "site_en": False},
        paths,
    )
    with sqlite3.connect(paths.pipeline_db) as conn:
        rows = conn.execute("SELECT locale, slug, html, site_enabled FROM post_locales ORDER BY locale").fetchall()
    assert rows[0][0] == "en"
    assert rows[0][3] == 0
    assert rows[1][0] == "ru"
    assert rows[1][2] == "<strong>Жирный</strong> текст"
    assert rows[1][3] == 1


def test_slug_and_utf16_entities():
    assert slugify("Apple removes VK from App Store", "en") == "apple-removes-vk-from-app-store"
    assert slugify("Apple удаляет VK", "ru") == "apple-udalyaet-vk"
    assert (
        entities_to_html(
            "😀 bold",
            [{"type": "bold", "offset": 3, "length": 4}],
        )
        == "😀 <strong>bold</strong>"
    )


def test_cancelled_unpublished_post_id_is_reused(tmp_path):
    paths = PostingPaths(
        data_dir=tmp_path,
        pipeline_db=tmp_path / "pipeline.db",
        controller_db=tmp_path / "pipeline.db",
    )
    with sqlite3.connect(paths.pipeline_db) as conn:
        conn.row_factory = sqlite3.Row
        ensure_pipeline_schema(conn)
        for draft_id in (1, 2):
            conn.execute(
                """
                INSERT INTO drafts(id, admin_id, status, text_ru, targets_json, created_at, updated_at)
                VALUES (?, 1, 'needs_review', 'text', '{}', 'now', 'now')
                """,
                (draft_id,),
            )
        conn.commit()
    assert ensure_publication(1, paths) == 1
    release_unpublished_publication(1, paths)
    assert ensure_publication(2, paths) == 1
