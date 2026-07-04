from __future__ import annotations

import hmac
import os

from fastapi import FastAPI, Request
from fastapi.responses import PlainTextResponse

from site_feed.bot_source import upsert_item
from site_feed.config import WEBHOOK_PATH, log
from site_feed.telegram import message_to_item


def register_telegram_routes(app: FastAPI) -> None:
    @app.post(WEBHOOK_PATH)
    async def telegram_webhook(request: Request):
        expected = os.environ.get("TELEGRAM_WEBHOOK_SECRET", "")
        received = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if not expected or not hmac.compare_digest(received, expected):
            return PlainTextResponse("forbidden\n", status_code=403)
        try:
            update = await request.json()
            if os.environ.get("CANONICAL_POSTS_ENABLED", "1").lower() not in {"0", "false", "no"}:
                return PlainTextResponse("ok\n")
            message = update.get("channel_post") or update.get("edited_channel_post")
            if message:
                item = message_to_item(message, edited="edited_channel_post" in update)
                if item:
                    upsert_item(item)
                    log(f"Принят Telegram post {item['message_id']}")
            return PlainTextResponse("ok\n")
        except Exception as exc:
            log(f"Ошибка webhook: {exc}")
            return PlainTextResponse("ok\n")
