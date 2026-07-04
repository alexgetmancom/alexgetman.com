from posting_core.media import plan_media_to_items
from posting_core.publishing import queued_media_to_items


def test_queued_media_accepts_local_path_without_file_id():
    items = queued_media_to_items([{"type": "photo", "local_path": "/var/lib/telegram-bot-api/file.jpg"}])

    assert items == [
        {
            "type": "IMAGE",
            "token": None,
            "local_path": "/var/lib/telegram-bot-api/file.jpg",
        }
    ]


def test_plan_media_accepts_local_path_without_file_id():
    items = plan_media_to_items({"media_en": [{"type": "photo", "local_path": "/var/lib/telegram-bot-api/en.jpg"}]})

    assert items == [
        {
            "type": "IMAGE",
            "token": None,
            "local_path": "/var/lib/telegram-bot-api/en.jpg",
        }
    ]
