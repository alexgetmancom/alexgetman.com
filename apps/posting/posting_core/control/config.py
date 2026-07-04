from __future__ import annotations

import json
import os
import time
from pathlib import Path
from posting_core.targets import CREDENTIAL_REQUIREMENTS
from posting_core.time_utils import now_iso

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = Path(os.environ.get("PIPELINE_DB", str(DATA_DIR / "pipeline.db")))
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR", str(DATA_DIR / "backups")))
CHANNEL_USERNAME = os.environ.get("CHANNEL_USERNAME", "alexgetmancom").lstrip("@")
BOT_API_BASE = os.environ.get("TELEGRAM_API_BASE_URL", "http://bot-api:8081").rstrip("/")
CONTROLLER_BOT_TOKEN = os.environ.get("CONTROLLER_BOT_TOKEN")
ADMIN_IDS = [int(x.strip()) for x in os.environ.get("CONTROLLER_ADMIN_IDS", "").split(",") if x.strip()]
COMMAND_CENTER_URL = os.environ.get("COMMAND_CENTER_URL", "https://alexgetman.com/command-center")
OBSERVABILITY_INTERVAL_SECONDS = int(os.environ.get("OBSERVABILITY_INTERVAL_SECONDS", "300"))
QUEUE_STALE_SECONDS = int(os.environ.get("QUEUE_STALE_SECONDS", "900"))
ALERT_COOLDOWN_SECONDS = int(os.environ.get("ALERT_COOLDOWN_SECONDS", "3600"))

LIFECYCLE_ORDER = ("draft", "approved", "publishing", "published", "metrics_active", "archived", "frozen")

def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def load_json(path, fallback):
    try:
        if Path(path).exists():
            data = json.loads(Path(path).read_text(encoding="utf-8"))
            return data if data is not None else fallback
    except Exception as exc:
        log(f"Cannot read {path}: {exc}")
    return fallback


def json_dumps(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def safe_int(value, default=0):
    try:
        return int(value)
    except Exception:
        return default


def post_key(message_id):
    return f"telegram:{CHANNEL_USERNAME}:{int(message_id)}"
