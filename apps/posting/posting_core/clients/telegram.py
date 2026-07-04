from __future__ import annotations

import os

from posting_core.http_client import request_json

TELEGRAM_API_BASE_URL = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org").rstrip("/")


def telegram_token(token=None):
    bot_token = token or os.environ.get("CONTROLLER_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
    if not bot_token:
        raise RuntimeError("missing Telegram bot token")
    return bot_token


def call_telegram(method, payload=None, token=None):
    bot_token = telegram_token(token)
    url = f"{TELEGRAM_API_BASE_URL}/bot{bot_token}/{method}"
    headers = {"Content-Type": "application/json"}
    return request_json(
        url,
        method="POST" if payload is not None else "GET",
        payload=payload,
        headers=headers,
        timeout=30,
    )


def get_telegram_file_url(file_id, token=None):
    bot_token = telegram_token(token)
    file_info = call_telegram("getFile", {"file_id": file_id}, token=bot_token)
    if file_info.get("ok"):
        file_path = file_info["result"]["file_path"]
        if os.path.isabs(file_path):
            return file_path
        return f"{TELEGRAM_API_BASE_URL}/file/bot{bot_token}/{file_path}"
    return None
