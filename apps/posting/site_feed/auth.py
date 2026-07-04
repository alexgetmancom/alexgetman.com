from __future__ import annotations

import hashlib
import hmac

from fastapi import Request

from site_feed.config import COMMAND_CENTER_TOKEN, require_env


def token_from_request(request: Request, payload_token: str | None = None) -> str:
    if payload_token:
        return payload_token.strip()
    header = request.headers.get("X-Command-Token") or request.headers.get("X-Admin-Token")
    if header:
        return header.strip()
    query_token = request.query_params.get("token")
    if query_token:
        return query_token
    return request.cookies.get("command_token", "")


def command_allowed(request: Request, payload_token: str | None = None) -> bool:
    proxy_user = request.headers.get("X-Authenticated-User")
    if proxy_user:
        return True
    if not COMMAND_CENTER_TOKEN:
        return False
    return hmac.compare_digest(token_from_request(request, payload_token), COMMAND_CENTER_TOKEN)


def client_ip_hash(request: Request) -> str:
    salt = require_env("LIKES_SALT")
    ip = request.headers.get("X-Forwarded-For") or (request.client.host if request.client else "")
    ip = ip.split(",", 1)[0].strip()
    return hashlib.sha256((ip + salt).encode("utf-8")).hexdigest()
