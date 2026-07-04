from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

MSK = ZoneInfo("Europe/Moscow")
MAX_POSTS_PER_DAY = 5

RU_SLOTS = ("10:37", "13:37", "17:37", "20:37", "23:37")
EN_SLOTS = ("00:37", "03:37", "06:37", "17:37", "20:37")


def _clock(value: str) -> time:
    hour, minute = (int(part) for part in value.split(":", 1))
    return time(hour, minute, tzinfo=MSK)


def daily_slots(day: date, locale: str) -> tuple[datetime, ...]:
    values = RU_SLOTS if locale == "ru" else EN_SLOTS
    return tuple(datetime.combine(day, _clock(value)) for value in values)


def future_slots(after: datetime, locale: str, count: int, days: int = 366) -> list[datetime]:
    if count < 0:
        raise ValueError("count must be non-negative")
    after = after.astimezone(MSK)
    result: list[datetime] = []
    for offset in range(days):
        day = after.date() + timedelta(days=offset)
        result.extend(slot for slot in daily_slots(day, locale) if slot > after)
        if len(result) >= count:
            return result[:count]
    raise RuntimeError(f"not enough {locale} slots")


def paired_schedule(after: datetime, count: int) -> list[tuple[datetime, datetime]]:
    if count < 1 or count > MAX_POSTS_PER_DAY:
        raise ValueError(f"post count must be between 1 and {MAX_POSTS_PER_DAY}")
    return list(zip(future_slots(after, "ru", count), future_slots(after, "en", count)))


def to_utc_iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def from_iso(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def format_msk(value: str | datetime) -> str:
    parsed = from_iso(value) if isinstance(value, str) else value
    return parsed.astimezone(MSK).strftime("%d.%m.%Y %H:%M MSK")
