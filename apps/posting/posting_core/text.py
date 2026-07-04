from __future__ import annotations

import re
import unicodedata

EMOJI_PATTERN = re.compile(
    r'^('
    r'[\u2700-\u27BF]|'
    r'[\u2600-\u26FF]|'
    r'[\u2B50\u2B06\u2194-\u21A0]|'
    r'[\U0001F600-\U0001F64F]|'
    r'[\U0001F300-\U0001F5FF]|'
    r'[\U0001F680-\U0001F6FF]|'
    r'[\U0001F900-\U0001F9FF]|'
    r'[\U0001FA70-\U0001FAFF]|'
    r'[\U0001F1E6-\U0001F1FF]|'
    r'[\U0001F400-\U0001F4FF]'
    r')[\u200d\ufe0f\u200c\u200b\U0001F3FB-\U0001F3FF]*',
    re.UNICODE
)

def strip_urls(text):
    if not text:
        return ""
    # Удаляем http:// и https:// ссылки
    text = re.sub(r'https?://\S+', '', text)
    # Удаляем лишние пробелы и переносы строк, которые могли остаться
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()


def clean_text(text):
    return re.sub(r"\n{3,}", "\n\n", (text or "").strip())


def compact_text(value):
    return re.sub(r"\s+", " ", clean_text(value)).strip()


def truncate_text(value, limit):
    value = compact_text(value)
    if len(value) <= limit:
        return value
    return value[: max(0, limit - 1)].rstrip() + "…"


def iter_graphemes(text: str):
    cluster = ""
    join_next = False
    for char in text or "":
        code = ord(char)
        is_mark = unicodedata.category(char).startswith("M")
        is_variation = 0xFE00 <= code <= 0xFE0F
        is_skin_tone = 0x1F3FB <= code <= 0x1F3FF
        is_joiner = char == "\u200d"
        if not cluster:
            cluster = char
        elif is_mark or is_variation or is_skin_tone or is_joiner or join_next:
            cluster += char
        else:
            yield cluster
            cluster = char
        join_next = is_joiner
    if cluster:
        yield cluster


def grapheme_len(text: str) -> int:
    return sum(1 for _ in iter_graphemes(text or ""))


def split_text(text, limit=500, length_func=len):
    if not text:
        return [""]
    if length_func(text) <= limit:
        return [text]
    
    parts = []
    lines = text.split('\n')
    current_part = ""
    
    for line in lines:
        if length_func(line) > limit:
            words = line.split(' ')
            for word in words:
                separator_len = 1 if current_part else 0
                if length_func(current_part) + length_func(word) + separator_len > limit:
                    if current_part:
                        parts.append(current_part.strip())
                    current_part = word
                else:
                    if current_part:
                        current_part += " " + word
                    else:
                        current_part = word
            current_part += "\n"
        else:
            if length_func(current_part) + length_func(line) + 1 > limit:
                parts.append(current_part.strip())
                current_part = line + "\n"
            else:
                current_part += line + "\n"
                
    if current_part.strip():
        parts.append(current_part.strip())
        
    return parts


def strip_leading_emojis(text):
    if not text:
        return text
    text = text.lstrip()
    while True:
        m = EMOJI_PATTERN.match(text)
        if not m:
            break
        text = text[m.end():].lstrip()
    return text
