from __future__ import annotations

import json
import os
import time
from pathlib import Path

from posting_core.clients.telegram import call_telegram

DATA_DIR = Path(os.environ.get('DATA_DIR', '/data'))
DB_PATH = Path(os.environ.get('CONTROLLER_DB') or os.environ.get('PIPELINE_DB', str(DATA_DIR / 'pipeline.db')))
BOT_TOKEN = os.environ['CONTROLLER_BOT_TOKEN']
ADMIN_IDS = {int(x.strip()) for x in os.environ.get('CONTROLLER_ADMIN_IDS', '').split(',') if x.strip()}
CHANNEL_ID = os.environ.get('CONTROLLER_CHANNEL_ID', '@alexgetmancom')
DEEPSEEK_API_KEY = os.environ.get('DEEPSEEK_API_KEY')
POLL_SECONDS = int(os.environ.get('CONTROLLER_POLL_SECONDS', '2'))
ALBUM_SETTLE_SECONDS = int(os.environ.get('CONTROLLER_ALBUM_SETTLE_SECONDS', '4'))

TEST_PLAN_TEXT = """Pipeline media test plan

Use Full preset unless a test says otherwise.

T01 Text only - send a plain text message.
T02 Text + picture - send 1 photo with caption.
T03 Text + pictures - send album with 2 photos and caption.
T04 Text + video - send 1 video with caption.
T05 Text + videos - send album with 2 videos and caption.
T06 Pictures only - send album with 2 photos, no caption.
T07 Videos only - send album with 2 videos, no caption.
T08 Video + picture - send album with 1 video + 1 photo and caption.
T09 Videos + pictures - send mixed album with 2+ videos and 2+ photos and caption.

Expected targets now:
Telegram, Site RU, Site EN, Threads RU, LinkedIn.

Known current rule:
LinkedIn supports image albums. Video albums and mixed media use a platform fallback, so the draft preview shows a partial-support note."""

def log(message):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


def api(method, payload=None):
    return call_telegram(method, payload, token=BOT_TOKEN)


def api_upload(method, payload, file_field, file_path):
    import requests

    bot_api_base = os.environ.get('TELEGRAM_API_BASE_URL', 'http://bot-api:8081').rstrip('/')
    url = f'{bot_api_base}/bot{BOT_TOKEN}/{method}'
    form = {}
    for key, value in (payload or {}).items():
        if isinstance(value, (dict, list)):
            form[key] = json.dumps(value, ensure_ascii=False)
        else:
            form[key] = value
    with open(file_path, 'rb') as handle:
        res = requests.post(url, data=form, files={file_field: handle}, timeout=60)
    if not (200 <= res.status_code < 300):
        res.raise_for_status()
    return res.json()
