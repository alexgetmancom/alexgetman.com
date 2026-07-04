import json
import os

os.environ.setdefault("CONTROLLER_BOT_TOKEN", "test-token")

from posting_core.controller import ui


def test_en_only_preset_disables_telegram_and_ru(monkeypatch):
    draft = {
        "id": 1,
        "media_ru_json": '[{"type": "photo", "file_id": "123"}]',
        "targets_json": "{}",
    }
    monkeypatch.setattr(ui, "get_draft", lambda draft_id: draft)
    updates = []
    monkeypatch.setattr(ui, "update_draft", lambda draft_id, **fields: updates.append(fields))

    ui.apply_preset(1, "en")

    targets = json.loads(updates[0]["targets_json"])
    assert targets["telegram"] is False
    assert targets["site_ru"] is False
    assert targets["threads_ru"] is False
    assert targets["site_en"] is True
    assert targets["linkedin"] is True
    assert targets["facebook"] is True
    assert targets["threads_en"] is True
    assert targets["x"] is True
    assert targets["telegram_stories"] is False
    assert targets["instagram_stories_ru"] is False
    assert targets["instagram_stories"] is True


def test_ru_only_preset_disables_en_targets(monkeypatch):
    draft = {
        "id": 1,
        "media_ru_json": '[{"type": "photo", "file_id": "123"}]',
        "targets_json": "{}",
    }
    monkeypatch.setattr(ui, "get_draft", lambda draft_id: draft)
    updates = []
    monkeypatch.setattr(ui, "update_draft", lambda draft_id, **fields: updates.append(fields))

    ui.apply_preset(1, "ru")

    targets = json.loads(updates[0]["targets_json"])
    assert targets["telegram"] is True
    assert targets["site_ru"] is True
    assert targets["threads_ru"] is True
    assert targets["facebook_ru"] is True
    assert targets["github_ru"] is True
    assert targets["site_en"] is False
    assert targets["linkedin"] is False
    assert targets["facebook"] is False
    assert targets["threads_en"] is False
    assert targets["x"] is False


def test_full_preset_enables_both_locales(monkeypatch):
    draft = {
        "id": 1,
        "media_ru_json": '[{"type": "photo", "file_id": "123"}]',
        "targets_json": "{}",
    }
    monkeypatch.setattr(ui, "get_draft", lambda draft_id: draft)
    updates = []
    monkeypatch.setattr(ui, "update_draft", lambda draft_id, **fields: updates.append(fields))

    ui.apply_preset(1, "full")

    targets = json.loads(updates[0]["targets_json"])
    assert targets["telegram"] is True
    assert targets["site_ru"] is True
    assert targets["site_en"] is True
    assert targets["threads_ru"] is True
    assert targets["threads_en"] is True
    assert targets["linkedin"] is True
    assert targets["telegram_stories"] is True
    assert targets["instagram_stories_ru"] is True
    assert targets["instagram_stories"] is True


def test_schedule_keyboard_opens_editable_draft():
    keyboard = ui.schedule_keyboard(
        [
            {
                "id": 9,
                "post_id": 1,
                "scheduled_at": None,
                "scheduled_en_at": "2026-06-25T00:37:00+00:00",
            }
        ]
    )

    button = keyboard["inline_keyboard"][0][0]
    assert button["callback_data"] == "schedule_open:9"
    assert button["text"].startswith("#1")
