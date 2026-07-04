import json

import pytest

from posting_core.controller.limits import DraftTextTooLong, MAX_DRAFT_TEXT_CHARS, validate_draft_text
from posting_core.queue_errors import normalize_publish_result
from posting_core.text import grapheme_len, split_text


def test_draft_limit_accepts_exactly_1000_chars():
    validate_draft_text("x" * MAX_DRAFT_TEXT_CHARS, "RU")
    validate_draft_text("x" * MAX_DRAFT_TEXT_CHARS, "EN")


def test_draft_limit_rejects_1001_chars_with_locale_message():
    with pytest.raises(DraftTextTooLong) as ru_exc:
        validate_draft_text("x" * (MAX_DRAFT_TEXT_CHARS + 1), "RU")
    assert "1001/1000" in ru_exc.value.message()
    assert "Текст слишком длинный" in ru_exc.value.message()

    with pytest.raises(DraftTextTooLong) as en_exc:
        validate_draft_text("x" * (MAX_DRAFT_TEXT_CHARS + 1), "EN")
    assert "1001/1000" in en_exc.value.message()
    assert "English text is too long" in en_exc.value.message()


def test_grapheme_len_treats_joined_emoji_as_one_unit():
    assert grapheme_len("👨‍💻") == 1
    assert grapheme_len("a👨‍💻b") == 3


def test_split_text_supports_grapheme_aware_limits():
    text = " ".join(["👨‍💻"] * 151)
    parts = split_text(text, limit=300, length_func=grapheme_len)

    assert len(parts) == 2
    assert all(grapheme_len(part) <= 300 for part in parts)


def test_normalize_publish_result_preserves_thread_ids():
    status, external_id, external_ids, url, error, skipped, raw = normalize_publish_result(
        {
            "ok": True,
            "id": "root",
            "url": "https://example.com/root",
            "ids": ["root", "reply-1"],
            "urls": ["https://example.com/root", "https://example.com/reply-1"],
        }
    )

    assert status == "published"
    assert external_id == "root"
    assert external_ids == ["root", "reply-1"]
    assert url == "https://example.com/root"
    assert error is None
    assert skipped == 0
    assert json.loads(raw)["urls"] == ["https://example.com/root", "https://example.com/reply-1"]
