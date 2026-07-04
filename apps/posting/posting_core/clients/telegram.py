from __future__ import annotations

import os

from posting_core.http_client import request_json
from posting_core.publish_config import TELEGRAM_API_BASE_URL, TELEGRAM_BOT_TOKEN

def call_telegram(method, payload=None, token=None):
    bot_token = token or TELEGRAM_BOT_TOKEN
    url = f"{TELEGRAM_API_BASE_URL}/bot{bot_token}/{method}"
    headers = {"Content-Type": "application/json"}
    
    return request_json(
        url,
        method="POST" if payload else "GET",
        payload=payload if payload else None,
        headers=headers,
        timeout=30,
    )


def get_telegram_file_url(file_id, token=None):
    bot_token = token or TELEGRAM_BOT_TOKEN
    file_info = call_telegram("getFile", {"file_id": file_id}, token=bot_token)
    if file_info.get("ok"):
        file_path = file_info["result"]["file_path"]
        if os.path.isabs(file_path):
            return file_path
        return f"{TELEGRAM_API_BASE_URL}/file/bot{bot_token}/{file_path}"
    return None
