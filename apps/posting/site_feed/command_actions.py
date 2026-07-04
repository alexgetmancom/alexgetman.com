from __future__ import annotations

import json
from urllib.parse import parse_qs

from fastapi import Request
from pydantic import BaseModel

from posting_core.repair import RepairService, parse_media
from site_feed.config import RENDER_EVENT
from site_feed.bot_source import sync_bot_source


class CommandAction(BaseModel):
    action: str
    ref: str | None = None
    message_id: int | None = None
    target: str | None = None
    text_en: str | None = None
    media_en_json: str | None = None
    token: str | None = None


async def parse_action_request(request: Request) -> CommandAction:
    content_type = request.headers.get("content-type", "")
    raw = await request.body()
    if "application/json" in content_type:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    else:
        params = parse_qs(raw.decode("utf-8")) if raw else {}
        data = {key: values[0] for key, values in params.items() if values}
    return CommandAction(**data)


def run_command_action(action: CommandAction):
    service = RepairService(actor_type="command-center")
    ref = action.ref or (str(action.message_id) if action.message_id is not None else None)
    if not ref:
        raise ValueError("missing publication ref")
    if action.action in {"retry", "republish"}:
        result = service.requeue(ref, target=action.target)
    elif action.action == "edit_en":
        if action.message_id is None:
            raise ValueError("edit_en still requires Telegram message_id")
        result = service.edit_en(action.message_id, action.text_en or "")
    elif action.action == "replace_en_media":
        if action.message_id is None:
            raise ValueError("replace_en_media still requires Telegram message_id")
        result = service.replace_en_media(action.message_id, parse_media(action.media_en_json))
    elif action.action == "use_ru_media_for_en":
        if action.message_id is None:
            raise ValueError("use_ru_media_for_en still requires Telegram message_id")
        result = service.replace_en_media(action.message_id, None)
    else:
        raise ValueError(f"unknown action: {action.action}")
    if action.action in {"edit_en", "replace_en_media", "use_ru_media_for_en"}:
        sync_bot_source()
        RENDER_EVENT.set()
    return result
