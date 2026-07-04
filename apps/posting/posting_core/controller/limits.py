from __future__ import annotations

MAX_DRAFT_TEXT_CHARS = 1000


class DraftTextTooLong(ValueError):
    def __init__(self, actual: int, limit: int = MAX_DRAFT_TEXT_CHARS, locale: str = "RU"):
        self.actual = actual
        self.limit = limit
        self.locale = locale.upper()
        super().__init__(self.message())

    def message(self) -> str:
        if self.locale == "EN":
            return f"English text is too long: {self.actual}/{self.limit} characters."
        return f"Текст слишком длинный: {self.actual}/{self.limit} символов."


def validate_draft_text(text: str | None, locale: str = "RU") -> None:
    actual = len((text or "").strip())
    if actual > MAX_DRAFT_TEXT_CHARS:
        raise DraftTextTooLong(actual=actual, locale=locale)
