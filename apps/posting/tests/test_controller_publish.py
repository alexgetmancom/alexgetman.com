import os

import pytest

os.environ.setdefault("CONTROLLER_BOT_TOKEN", "test-token")

from posting_core.controller import publish as controller_publish


def test_en_only_publish_does_not_call_telegram(monkeypatch):
    draft = {
        "id": 7,
        "status": "needs_review",
        "post_id": 1,
        "channel_message_id": None,
        "scheduled_at": None,
        "text_ru": "RU",
        "text_en_approved": "EN",
        "text_en_machine": "EN",
        "media_ru_json": None,
        "media_en_json": None,
        "text_ru_entities_json": None,
    }
    monkeypatch.setattr(
        controller_publish,
        "targets_for",
        lambda value: {
            "telegram": False,
            "site_ru": False,
            "site_en": True,
            "linkedin": True,
        },
    )
    monkeypatch.setattr(controller_publish, "media_for", lambda value, locale: None)
    monkeypatch.setattr(
        controller_publish,
        "api",
        lambda method, payload: pytest.fail("Telegram API must not be called"),
    )
    monkeypatch.setattr(
        controller_publish,
        "sync_publication_from_draft",
        lambda draft, targets: 1,
    )
    enqueued = []
    monkeypatch.setattr(
        controller_publish,
        "enqueue_publication",
        lambda *args, **kwargs: enqueued.append((args, kwargs)),
    )
    updates = []
    monkeypatch.setattr(
        controller_publish,
        "update_draft",
        lambda draft_id, **fields: updates.append((draft_id, fields)),
    )

    class FakeConn:
        def execute(self, *args, **kwargs):
            return self

        def commit(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

    monkeypatch.setattr(controller_publish, "db", lambda: FakeConn())

    post_id = controller_publish.publish_to_channel(draft, publish_now=True)

    assert post_id == 1
    assert enqueued[0][0][0] == 1
    assert enqueued[0][1]["enqueue_targets"] == {"linkedin": True}
    assert enqueued[0][0][3]["telegram_url"] is None
    assert updates[0][1]["post_id"] == 1


def test_telegram_entities_are_preserved(monkeypatch):
    draft = {
        "id": 8,
        "status": "needs_review",
        "post_id": 2,
        "channel_message_id": None,
        "scheduled_at": None,
        "text_ru": "Bold",
        "text_en_approved": "",
        "text_en_machine": "",
        "media_ru_json": None,
        "media_en_json": None,
        "text_ru_entities_json": '[{"type":"bold","offset":0,"length":4}]',
    }
    monkeypatch.setattr(
        controller_publish,
        "targets_for",
        lambda value: {"telegram": True, "site_ru": False, "site_en": False},
    )
    monkeypatch.setattr(controller_publish, "media_for", lambda value, locale: None)
    calls = []

    def fake_api(method, payload):
        calls.append((method, payload))
        return {"ok": True, "result": {"message_id": 500, "chat": {"id": -100}}}

    monkeypatch.setattr(controller_publish, "api", fake_api)
    monkeypatch.setattr(controller_publish, "sync_publication_from_draft", lambda draft, targets: 2)
    monkeypatch.setattr(controller_publish, "enqueue_publication", lambda *args, **kwargs: None)
    monkeypatch.setattr(controller_publish, "update_draft", lambda *args, **kwargs: None)

    class FakeConn:
        def execute(self, *args, **kwargs):
            return self

        def commit(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

    monkeypatch.setattr(controller_publish, "db", lambda: FakeConn())

    assert controller_publish.publish_to_channel(draft) == 2
    assert calls[0] == (
        "sendMessage",
        {
            "chat_id": controller_publish.CHANNEL_ID,
            "text": "Bold",
            "disable_web_page_preview": False,
            "entities": [{"type": "bold", "offset": 0, "length": 4}],
        },
    )


def test_telegram_photo_prefers_local_path(monkeypatch):
    draft = {
        "id": 9,
        "status": "needs_review",
        "post_id": 3,
        "channel_message_id": None,
        "scheduled_at": None,
        "text_ru": "Caption",
        "text_en_approved": "",
        "text_en_machine": "",
        "media_ru_json": '[{"type":"photo","file_id":"old-file","local_path":"/var/lib/telegram-bot-api/file.jpg"}]',
        "media_en_json": None,
        "text_ru_entities_json": None,
    }
    monkeypatch.setattr(controller_publish, "targets_for", lambda value: {"telegram": True})
    monkeypatch.setattr(
        controller_publish,
        "media_for",
        lambda value, locale: [
            {"type": "photo", "file_id": "old-file", "local_path": "/var/lib/telegram-bot-api/file.jpg"}
        ],
    )
    calls = []

    def fake_api(method, payload):
        pytest.fail("JSON Telegram API must not be used for local file upload")

    def fake_upload(method, payload, file_field, file_path):
        calls.append((method, payload, file_field, file_path))
        return {"ok": True, "result": {"message_id": 501, "chat": {"id": -100}}}

    monkeypatch.setattr(controller_publish, "api", fake_api)
    monkeypatch.setattr(controller_publish, "api_upload", fake_upload)
    monkeypatch.setattr(controller_publish, "sync_publication_from_draft", lambda draft, targets: 3)
    monkeypatch.setattr(controller_publish, "enqueue_publication", lambda *args, **kwargs: None)
    monkeypatch.setattr(controller_publish, "update_draft", lambda *args, **kwargs: None)

    class FakeConn:
        def execute(self, *args, **kwargs):
            return self

        def commit(self):
            return None

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

    monkeypatch.setattr(controller_publish, "db", lambda: FakeConn())

    assert controller_publish.publish_to_channel(draft) == 3
    assert calls[0] == (
        "sendPhoto",
        {"chat_id": controller_publish.CHANNEL_ID, "caption": "Caption"},
        "photo",
        "/var/lib/telegram-bot-api/file.jpg",
    )
