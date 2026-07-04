from __future__ import annotations

import html
import json
import re
from typing import Any


_RU_TRANSLIT = str.maketrans(
    {
        "а": "a",
        "б": "b",
        "в": "v",
        "г": "g",
        "д": "d",
        "е": "e",
        "ё": "e",
        "ж": "zh",
        "з": "z",
        "и": "i",
        "й": "y",
        "к": "k",
        "л": "l",
        "м": "m",
        "н": "n",
        "о": "o",
        "п": "p",
        "р": "r",
        "с": "s",
        "т": "t",
        "у": "u",
        "ф": "f",
        "х": "h",
        "ц": "ts",
        "ч": "ch",
        "ш": "sh",
        "щ": "sch",
        "ъ": "",
        "ы": "y",
        "ь": "",
        "э": "e",
        "ю": "yu",
        "я": "ya",
    }
)


def title_from_text(text: str) -> str:
    value = (text or "").strip().splitlines()[0] if (text or "").strip() else "post"
    return re.split(r"(?<=[.!?])\s+", value, maxsplit=1)[0].strip()


def slugify(text: str, locale: str, fallback: str = "post") -> str:
    value = title_from_text(text).lower()
    if locale == "ru":
        value = value.translate(_RU_TRANSLIT)
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return (value[:96].rstrip("-") or fallback).lower()


def _utf16_index(text: str, offset: int) -> int:
    units = 0
    for index, char in enumerate(text):
        if units >= offset:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
    return len(text)


def entities_to_html(text: str, entities: list[dict[str, Any]] | None) -> str:
    text = text or ""
    if not entities:
        return html.escape(text).replace("\n", "<br>")
    operations: list[tuple[int, int, str]] = []
    for entity in entities:
        start = _utf16_index(text, int(entity.get("offset") or 0))
        end = _utf16_index(
            text,
            int(entity.get("offset") or 0) + int(entity.get("length") or 0),
        )
        entity_type = entity.get("type")
        opening = closing = ""
        if entity_type == "bold":
            opening, closing = "<strong>", "</strong>"
        elif entity_type == "italic":
            opening, closing = "<em>", "</em>"
        elif entity_type == "underline":
            opening, closing = "<u>", "</u>"
        elif entity_type == "strikethrough":
            opening, closing = "<s>", "</s>"
        elif entity_type == "code":
            opening, closing = "<code>", "</code>"
        elif entity_type == "pre":
            opening, closing = "<pre><code>", "</code></pre>"
        elif entity_type == "text_link" and entity.get("url"):
            opening = f'<a href="{html.escape(str(entity["url"]), quote=True)}">'
            closing = "</a>"
        if opening:
            operations.append((start, 1, opening))
            operations.append((end, 0, closing))
    # Escaping changes indices, so rebuild by character boundaries instead.
    result = ""
    starts: dict[int, list[str]] = {}
    ends: dict[int, list[str]] = {}
    for index, kind, tag in operations:
        (starts if kind else ends).setdefault(index, []).append(tag)
    for index, char in enumerate(text):
        result += "".join(reversed(ends.get(index, [])))
        result += "".join(starts.get(index, []))
        result += html.escape(char)
    result += "".join(reversed(ends.get(len(text), [])))
    return result.replace("\n", "<br>")


def parse_entities(value: str | None) -> list[dict[str, Any]]:
    try:
        parsed = json.loads(value or "[]")
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []
