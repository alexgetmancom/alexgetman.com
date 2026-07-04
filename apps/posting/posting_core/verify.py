from __future__ import annotations

import urllib.parse
import urllib.request
from typing import Any

from .clients.bluesky import verify_bluesky_root_visible
from .social_urls import target_public_url


def _http_visible(url: str, timeout: int = 15) -> tuple[bool, str | None]:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "alexgetman-posting-verify/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return int(resp.status) < 500, f"http_{resp.status}"
    except Exception as exc:
        return False, str(exc)


def verify_target_record(record: dict[str, Any]) -> dict[str, Any]:
    target = record.get("target")
    status = record.get("status")
    external_id = record.get("external_id")
    url = target_public_url(str(target or ""), external_id=external_id, url=record.get("url"))
    if status != "published":
        return {"target": target, "ok": False, "status": status, "url": url, "reason": record.get("error") or "not_published"}
    if target == "bluesky":
        ok, reason = verify_bluesky_root_visible(external_id)
        return {"target": target, "ok": ok, "status": status, "url": url, "reason": reason}
    if url:
        ok, reason = _http_visible(url)
        return {"target": target, "ok": ok, "status": status, "url": url, "reason": reason}
    return {"target": target, "ok": True, "status": status, "url": url, "reason": "no_public_url_known"}
