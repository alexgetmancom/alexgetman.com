from __future__ import annotations

import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from posting_core.text import clean_text as _clean_text
from posting_core.text import compact_text as _compact_text
from posting_core.text import truncate_text as _truncate_text

CHANNEL_USERNAME = os.environ.get("CHANNEL_USERNAME", "iAlexeyRu").lstrip("@")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/home/deploy/ialexey-feed/data"))
SITE_INDEX = Path(os.environ.get("SITE_INDEX", "/home/deploy/ialexey-web/index.html"))
SOURCE_INDEX = Path(os.environ.get("SOURCE_INDEX", "/home/deploy/repos/ialexey-web/index.html"))
SITE_ROOT = Path(os.environ.get("SITE_ROOT", str(SITE_INDEX.parent)))
WEBHOOK_PATH = os.environ.get("WEBHOOK_PATH", "/tg-feed/webhook")
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "https://alexgetman.com").rstrip("/")
TELEGRAM_API_BASE_URL = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org").rstrip("/")
PORT = int(os.environ.get("PORT", "8788"))
BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
MAX_ITEMS = int(os.environ.get("MAX_ITEMS", "12"))
BOT_SOURCE_POLL_SECONDS = int(os.environ.get("BOT_SOURCE_POLL_SECONDS", "5"))

FEED_JSON = DATA_DIR / "feed.json"
RENDER_EVENT = threading.Event()
RENDER_LOCK = threading.Lock()
RENDER_ASYNC_ENABLED = False
METRICS_JSON = DATA_DIR / "metrics.json"
LIKES_DB = DATA_DIR / "likes.db"
LIKES_LOCK = threading.Lock()
INDEXNOW_STATE_JSON = DATA_DIR / "indexnow.json"
INDEXNOW_KEY_FILE = DATA_DIR / "indexnow.key"
PUBLIC_FEED_JSON = SITE_ROOT / "feed.json"
PUBLIC_CONTENT_INDEX_JSON = SITE_ROOT / "content-index.json"
PUBLIC_CONTENT_MEMORY_MD = SITE_ROOT / "content-memory.md"
SOURCE_MEDIA_DIR = Path(
    os.environ.get(
        "SOURCE_MEDIA_DIR",
        str(Path(os.environ.get("SOURCE_INDEX", "/home/deploy/repos/ialexey-web/index.html")).parent / "public" / "media"),
    )
)
PUBLIC_MEDIA_DIR = Path("/home/deploy/ialexey-web/media")
PIPELINE_DB = Path(os.environ.get("PIPELINE_DB", "/opt/telegram-to-threads/data/pipeline.db"))
CONTROLLER_DB = Path(os.environ.get("CONTROLLER_DB", os.environ.get("PIPELINE_DB", "/data/pipeline.db")))
PIPELINE_BASELINE_MESSAGE_ID = int(os.environ.get("PIPELINE_BASELINE_MESSAGE_ID", "422"))
COMMAND_CENTER_TOKEN = os.environ.get("COMMAND_CENTER_TOKEN") or os.environ.get("TELEGRAM_WEBHOOK_SECRET")
METRICS_LOCK = threading.Lock()
SITE_TITLE = "Алексей Гетманец | Сливы и новости ИИ"
SITE_DESCRIPTION = "Сливы и новости ИИ от Алексея Гетманца: короткая Telegram-лента, RSS и статические страницы постов."
SITE_AUTHOR = "Алексей Гетманец"
X_PROFILE_URL = "https://x.com/iAlexeyRu"
TELEGRAM_URL = f"https://t.me/{CHANNEL_USERNAME}"

def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def log(message):
    print(message, flush=True)


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Не задана переменная окружения {name}")
    return value


def atomic_write(path, content, permissions=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    if permissions is None and path.exists():
        permissions = path.stat().st_mode & 0o777
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as tmp:
        tmp.write(content)
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)
    if permissions is not None:
        os.chmod(path, permissions)


def site_url(path="/"):
    path = str(path or "/")
    if not path.startswith("/"):
        path = "/" + path
    return PUBLIC_BASE_URL + path


def public_url_host():
    return urlparse(PUBLIC_BASE_URL).netloc or "alexgetman.com"


def parse_date(value):
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def clean_text(text):
    return _clean_text(text)


def compact_text(value):
    return _compact_text(value)


def truncate_text(value, limit):
    return _truncate_text(value, limit)


def post_path(item):
    post_id = int(item.get("post_id") or 0)
    if item.get("has_en"):
        return f"/{post_id}/{item.get('slug_en') or f'post-{post_id}'}/"
    return f"/ru/{post_id}/{item.get('slug_ru') or f'post-{post_id}'}/"
