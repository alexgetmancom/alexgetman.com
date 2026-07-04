from posting_core.db import connect, ensure_pipeline_schema
from site_feed import render
from site_feed import pipeline
from site_feed import metrics as site_metrics
from site_feed.bot_source import bot_source_to_item


def test_bot_source_keeps_en_media_separate(monkeypatch):
    source = {
        "post_id": 1,
        "telegram_message_id": 999,
        "text_ru": "ru",
        "text_en": "en",
        "targets": {"site_ru": True, "site_en": True},
        "locales": {
            "ru": {"text": "ru", "html": "ru", "slug": "ru"},
            "en": {"text": "en", "html": "en", "slug": "en"},
        },
        "media_ru": [{"type": "photo", "file_id": "ru-file"}],
        "media_en": [{"type": "photo", "file_id": "en-file"}],
    }

    def fake_download(file_id, message_id, media_type, index=0, token=None):
        return f"media/{message_id}-{file_id}.{media_type}"

    monkeypatch.setattr("site_feed.bot_source.download_telegram_media", fake_download)
    item = bot_source_to_item(source)

    assert item["media"] == [{"type": "image", "path": "media/1-ru-file.image"}]
    assert item["media_en"] == [{"type": "image", "path": "media/1-en-en-file.image"}]
    assert item["image"] == "media/1-ru-file.image"
    assert item["image_en"] == "media/1-en-en-file.image"


def test_bot_source_accepts_local_media_path(monkeypatch):
    source = {
        "post_id": 2,
        "text_ru": "ru",
        "targets": {"site_ru": True},
        "locales": {"ru": {"text": "ru", "html": "ru", "slug": "ru"}},
        "media_ru": [{"type": "photo", "local_path": "/var/lib/telegram-bot-api/file.jpg"}],
    }

    calls = []

    def fake_download_media(url, message_id, suffix, index=0):
        calls.append((url, message_id, suffix, index))
        return f"media/{message_id}.{suffix}"

    monkeypatch.setattr("site_feed.bot_source.download_media", fake_download_media)
    item = bot_source_to_item(source)

    assert calls == [("/var/lib/telegram-bot-api/file.jpg", 2, "jpg", 0)]
    assert item["media"] == [{"type": "image", "path": "media/2.jpg"}]
    assert item["image"] == "media/2.jpg"


def test_bot_source_adds_video_poster(monkeypatch):
    source = {
        "post_id": 3,
        "text_ru": "ru",
        "targets": {"site_ru": True},
        "locales": {"ru": {"text": "ru", "html": "ru", "slug": "ru"}},
        "media_ru": [{"type": "video", "local_path": "/var/lib/telegram-bot-api/file.mp4"}],
    }

    monkeypatch.setattr("site_feed.bot_source.download_media", lambda *args, **kwargs: "media/3.mp4")
    monkeypatch.setattr("site_feed.bot_source.video_poster_path", lambda path: "media/3-poster.jpg")

    item = bot_source_to_item(source)

    assert item["media"] == [{"type": "video", "path": "media/3.mp4", "poster": "media/3-poster.jpg"}]
    assert item["image"] is None


def test_bot_source_falls_back_to_existing_media_when_source_path_is_stale(tmp_path, monkeypatch):
    (tmp_path / "20-en.jpg").write_bytes(b"existing image")
    public_dir = tmp_path / "public"
    public_dir.mkdir()

    source = {
        "post_id": 20,
        "text_en": "en",
        "targets": {"site_en": True},
        "locales": {"en": {"text": "en", "html": "en", "slug": "en"}},
        "media_en": [
            {
                "type": "photo",
                "file_id": "stale-file-id",
                "local_path": "/var/lib/telegram-bot-api/missing.jpg",
            }
        ],
    }

    monkeypatch.setattr("site_feed.bot_source.SOURCE_MEDIA_DIR", tmp_path)
    monkeypatch.setattr("site_feed.bot_source.PUBLIC_MEDIA_DIR", public_dir)
    monkeypatch.setattr("site_feed.bot_source.download_media", lambda *args, **kwargs: None)
    monkeypatch.setattr("site_feed.bot_source.download_telegram_media", lambda *args, **kwargs: None)

    item = bot_source_to_item(source)

    assert item["media_en"] == [{"type": "image", "path": "media/20-en.jpg"}]
    assert item["image_en"] == "media/20-en.jpg"


def test_publish_content_index_uses_pipeline_db_explicit_import(tmp_path, monkeypatch):
    db_path = tmp_path / "pipeline.db"
    with connect(db_path) as conn:
        ensure_pipeline_schema(conn)
        conn.commit()

    monkeypatch.setattr(render, "PIPELINE_DB", db_path)
    monkeypatch.setattr(render, "PUBLIC_CONTENT_INDEX_JSON", tmp_path / "content-index.json")
    monkeypatch.setattr(render, "PUBLIC_CONTENT_MEMORY_MD", tmp_path / "content-memory.md")
    render.publish_content_index()

    assert (tmp_path / "content-index.json").exists()
    assert (tmp_path / "content-memory.md").exists()


def test_pipeline_publications_include_legacy_telegram_posts(tmp_path, monkeypatch):
    db_path = tmp_path / "pipeline.db"
    with connect(db_path) as conn:
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO posts(
                post_key, channel, message_id, date_utc, text, text_en,
                media_count, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?, ?)
            """,
            (
                "telegram:alexgetmancom:422",
                "alexgetmancom",
                422,
                "2026-06-21T13:09:40+00:00",
                "legacy ru",
                "legacy en",
                "2026-06-21T13:09:40+00:00",
                "2026-06-21T13:09:40+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO post_targets(post_key, target, status, external_id, url, updated_at)
            VALUES (?, 'threads_ru', 'published', ?, ?, ?)
            """,
            (
                "telegram:alexgetmancom:422",
                "181000",
                "https://www.threads.com/@alexgetmanru/post/example",
                "2026-06-21T13:10:00+00:00",
            ),
        )
        conn.execute(
            """
            INSERT INTO post_metrics(post_key, target, metric_name, value, sampled_at, source)
            VALUES (?, 'threads_ru', 'views', 9082, ?, 'threads_insights_api')
            """,
            ("telegram:alexgetmancom:422", "2026-07-03T09:40:00+00:00"),
        )
        conn.commit()

    monkeypatch.setattr(pipeline, "PIPELINE_DB", db_path)
    posts = pipeline.load_pipeline_publications(week_offset=2)

    assert [post["telegram_message_id"] for post in posts] == [422]
    assert posts[0]["post_id"] is None
    assert posts[0]["full_text_ru"] == "legacy ru"
    assert posts[0]["metrics"]["threads_ru"]["views"]["value"] == 9082


def test_pageview_updates_pipeline_site_metric(tmp_path, monkeypatch):
    db_path = tmp_path / "pipeline.db"
    metrics_path = tmp_path / "metrics.json"
    with connect(db_path) as conn:
        ensure_pipeline_schema(conn)
        conn.execute(
            """
            INSERT INTO posts(
                post_key, post_id, channel, message_id, date_utc, site_ru_path,
                media_count, status, created_at, updated_at
            ) VALUES ('post:7', 7, 'alexgetmancom', 441, '2026-06-26T08:51:47+00:00',
                      '/ru/7/example/', 0, 'active', '2026-06-26T08:51:47+00:00', '2026-06-26T08:51:47+00:00')
            """
        )
        conn.commit()

    monkeypatch.setattr(site_metrics, "PIPELINE_DB", db_path)
    monkeypatch.setattr("site_feed.feed_store.METRICS_JSON", metrics_path)

    site_metrics.record_pageview("/ru/7/example/")

    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT value, source FROM post_metrics WHERE post_key='post:7' AND target='site_ru' AND metric_name='views'"
        ).fetchone()
    assert dict(row) == {"value": 1, "source": "site_pageview_endpoint"}


def test_bot_source_hides_future_locale():
    item = bot_source_to_item(
        {
            "post_id": 1,
            "targets": {"site_ru": True, "site_en": True},
            "publish_at_ru": "2999-01-01T00:00:00+00:00",
            "publish_at_en": "2000-01-01T00:00:00+00:00",
            "locales": {
                "ru": {"text": "ru", "html": "ru", "slug": "ru"},
                "en": {"text": "en", "html": "en", "slug": "en"},
            },
        }
    )

    assert item["has_ru"] is False
    assert item["has_en"] is True
    assert item["text"] == ""
    assert item["text_en"] == "en"
