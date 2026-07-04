from __future__ import annotations

import json
import os
import urllib.parse
from typing import Any

from .db import connect
from .http_client import HttpRequestError, request

def load_secrets(paths) -> dict[str, str]:
        values = dict(os.environ)
        for path in (paths.data_dir.parent / "secrets.env", paths.data_dir / "secrets.env",):
            if not path.exists():
                continue
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values.setdefault(key.strip(), value.strip())
        return values


def post_json(url: str, payload: dict[str, Any], headers: dict[str, str] | None = None, timeout: int = 15) -> tuple[int, dict[str, Any] | None]:
        response = request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", **(headers or {})},
            method="POST",
            timeout=timeout,
        )
        return response.status, json.loads(response.body.decode("utf-8")) if response.body else None


def edit_published_targets(paths, post: Any, text_ru: str | None, text_en: str | None) -> list[dict[str, Any]]:
        secrets = load_secrets(paths)
        results: list[dict[str, Any]] = []
        with connect(paths.pipeline_db) as conn:
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(post_targets)").fetchall()}
            if not {"target", "status", "external_id"}.issubset(columns):
                return results
            targets = conn.execute(
                "SELECT target, status, external_id FROM post_targets WHERE post_key=?",
                (post["post_key"],),
            ).fetchall()
        for row in targets:
            target = row["target"]
            external_id = row["external_id"]
            if row["status"] != "published" or not external_id:
                continue
            try:
                if target == "telegram" and text_ru:
                    token = secrets.get("CONTROLLER_BOT_TOKEN") or secrets.get("TELEGRAM_BOT_TOKEN")
                    if not token:
                        results.append({"target": target, "ok": False, "skipped": True, "error": "missing CONTROLLER_BOT_TOKEN"})
                        continue
                    method = "editMessageCaption" if int(post["media_count"] or 0) > 0 else "editMessageText"
                    field = "caption" if int(post["media_count"] or 0) > 0 else "text"
                    base_url = os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org").rstrip("/")
                    status, data = post_json(
                        f"{base_url}/bot{token}/{method}",
                        {"chat_id": post["chat_id"] or "-1003672693095", "message_id": int(external_id), field: text_ru},
                    )
                    results.append({"target": target, "ok": bool(data and data.get("ok")), "status": status, "response": data})
                elif target == "facebook" and text_en:
                    token = secrets.get("FACEBOOK_PAGE_ACCESS_TOKEN")
                    if not token:
                        results.append({"target": target, "ok": False, "skipped": True, "error": "missing FACEBOOK_PAGE_ACCESS_TOKEN"})
                        continue
                    status, data = post_json(
                        f"https://graph.facebook.com/v18.0/{external_id}",
                        {"message": text_en, "description": text_en},
                        {"Authorization": f"Bearer {token}"},
                    )
                    results.append({"target": target, "ok": bool(data and (data.get("success") or data.get("id"))), "status": status, "response": data})
                elif target == "facebook_ru" and text_ru:
                    token = secrets.get("FACEBOOK_RU_PAGE_ACCESS_TOKEN")
                    if not token:
                        results.append({"target": target, "ok": False, "skipped": True, "error": "missing FACEBOOK_RU_PAGE_ACCESS_TOKEN"})
                        continue
                    status, data = post_json(
                        f"https://graph.facebook.com/v18.0/{external_id}",
                        {"message": text_ru, "description": text_ru},
                        {"Authorization": f"Bearer {token}"},
                    )
                    results.append({"target": target, "ok": bool(data and (data.get("success") or data.get("id"))), "status": status, "response": data})
                elif target == "linkedin" and text_en:
                    token = secrets.get("LINKEDIN_ACCESS_TOKEN")
                    if not token:
                        results.append({"target": target, "ok": False, "skipped": True, "error": "missing LINKEDIN_ACCESS_TOKEN"})
                        continue
                    status, data = post_json(
                        f"https://api.linkedin.com/rest/posts/{urllib.parse.quote(external_id)}",
                        {"patch": {"$set": {"commentary": text_en}}},
                        {
                            "Authorization": f"Bearer {token}",
                            "Linkedin-Version": "202606",
                            "X-Restli-Method": "PARTIAL_UPDATE",
                            "X-Restli-Protocol-Version": "2.0.0",
                        },
                    )
                    results.append({"target": target, "ok": status in {200, 204}, "status": status, "response": data})
            except HttpRequestError as exc:
                results.append({"target": target, "ok": False, "status": exc.status, "error": exc.body})
            except Exception as exc:
                results.append({"target": target, "ok": False, "error": str(exc)})
        return results
