import sqlite3

from posting_core.db import ensure_pipeline_schema
from posting_core.ops_lookup import resolve_publication_ref


def test_resolve_numeric_prefers_canonical_post_id(tmp_path):
    db_path = tmp_path / "pipeline.db"
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO publications(post_id, draft_id, status, telegram_message_id, created_at, updated_at)
            VALUES(19, 1, 'published', 453, 'now', 'now')
            """
        )

        ref = resolve_publication_ref(conn, "19")

    assert ref.post_key == "post:19"
    assert ref.post_id == 19
    assert ref.message_id == 453


def test_resolve_message_prefix_uses_telegram_message_id(tmp_path):
    db_path = tmp_path / "pipeline.db"
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO posts(post_key, post_id, channel, message_id, status, created_at, updated_at)
            VALUES('post:19', 19, 'alexgetmancom', 453, 'active', 'now', 'now')
            """
        )

        ref = resolve_publication_ref(conn, "msg:453")

    assert ref.post_key == "post:19"
    assert ref.post_id == 19
    assert ref.message_id == 453


def test_resolve_post_key_without_rows_keeps_canonical_id(tmp_path):
    db_path = tmp_path / "pipeline.db"
    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        ensure_pipeline_schema(conn)

        ref = resolve_publication_ref(conn, "post:77")

    assert ref.post_key == "post:77"
    assert ref.post_id == 77
    assert ref.message_id is None
