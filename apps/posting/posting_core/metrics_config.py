from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from posting_core.targets import ALL_TARGET_IDS as TARGETS, METRIC_TARGET_IDS

SCHEDULED_TARGETS = tuple(target for target in METRIC_TARGET_IDS if target not in {"x", "linkedin"})

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = Path(os.environ.get("PIPELINE_DB", str(DATA_DIR / "pipeline.db")))
FEED_JSON = Path(os.environ.get("FEED_JSON", "/feed-data/feed.json"))
SITE_METRICS_JSON = Path(os.environ.get("SITE_METRICS_JSON", "/feed-data/metrics.json"))
CHANNEL_USERNAME = os.environ.get("CHANNEL_USERNAME", "alexgetmancom").lstrip("@")
REFRESH_INTERVAL_SECONDS = int(os.environ.get("METRICS_REFRESH_INTERVAL_SECONDS", "300"))
TELEGRAM_TIMEOUT_SECONDS = int(os.environ.get("TELEGRAM_METRICS_TIMEOUT_SECONDS", "10"))
THREADS_ACCESS_TOKEN = os.environ.get("THREADS_ACCESS_TOKEN")
THREADS_EN_ACCESS_TOKEN = os.environ.get("THREADS_EN_ACCESS_TOKEN")
FACEBOOK_PAGE_ACCESS_TOKEN = os.environ.get("FACEBOOK_PAGE_ACCESS_TOKEN")
FACEBOOK_RU_PAGE_ACCESS_TOKEN = os.environ.get("FACEBOOK_RU_PAGE_ACCESS_TOKEN")
GITHUB_DISCUSSIONS_TOKEN = os.environ.get("GITHUB_DISCUSSIONS_TOKEN")
TELEGRAM_CHANNEL_STORIES_API_ID = os.environ.get("TELEGRAM_CHANNEL_STORIES_API_ID") or os.environ.get("TELEGRAM_API_ID")
TELEGRAM_CHANNEL_STORIES_API_HASH = os.environ.get("TELEGRAM_CHANNEL_STORIES_API_HASH") or os.environ.get("TELEGRAM_API_HASH")
TELEGRAM_CHANNEL_STORIES_SESSION = os.environ.get("TELEGRAM_CHANNEL_STORIES_SESSION", str(DATA_DIR / "telegram_channel_stories"))
FACEBOOK_GRAPH_API_VERSION = os.environ.get("FACEBOOK_GRAPH_API_VERSION", "v25.0").strip() or "v25.0"
if not FACEBOOK_GRAPH_API_VERSION.startswith("v"):
    FACEBOOK_GRAPH_API_VERSION = "v" + FACEBOOK_GRAPH_API_VERSION
THREADS_METRICS = os.environ.get("THREADS_METRICS", "views,likes,replies,reposts,quotes")
MAX_METRIC_TASKS_PER_CYCLE = int(os.environ.get("MAX_METRIC_TASKS_PER_CYCLE", "30"))
PIPELINE_BASELINE_MESSAGE_ID = int(os.environ.get("PIPELINE_BASELINE_MESSAGE_ID", "422"))

def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def load_json(path, fallback):
    try:
        if Path(path).exists():
            return json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:
        log(f"Cannot read {path}: {exc}")
    return fallback


def parse_dt(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def post_key(message_id):
    return f"telegram:{CHANNEL_USERNAME}:{int(message_id)}"


def iso_utc(dt):
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def utc_now_dt():
    return datetime.now(timezone.utc).replace(microsecond=0)


def parse_iso_dt(value):
    if not value:
        return utc_now_dt()
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return utc_now_dt()


def metric_interval_for_post(post_date_utc, check_count=0, now=None):
    # check_count - количество уже завершенных проверок в БД.
    # 0 -> 1-я проверка завершена, планируем 2-ю через 3 часа
    # 1 -> 2-я проверка завершена, планируем 3-ю через 6 часов
    # 2 -> 3-я проверка завершена, планируем 4-ю через 12 часов
    # 3 -> 4-я проверка завершена, планируем 5-ю через 24 часа (1 день)
    # 4 -> 5-я проверка завершена, планируем 6-ю через 48 часов (2 дня)
    # 5 -> 6-я проверка завершена, планируем 7-ю через неделю (7 дней)
    # 6 -> 7-я проверка завершена, планируем 8-ю через месяц (30 дней)
    # >=7 -> 8-я (или более) проверка завершена, далее не нужно (None)
    intervals = {
        0: timedelta(hours=3),
        1: timedelta(hours=6),
        2: timedelta(hours=12),
        3: timedelta(hours=24),
        4: timedelta(hours=48),
        5: timedelta(days=7),
        6: timedelta(days=30),
    }
    return intervals.get(check_count)
