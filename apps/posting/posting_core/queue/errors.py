from __future__ import annotations

import json
import os
import time
import urllib.error
from typing import Any

TRANSIENT_STATUS_CODES = {408, 425, 429, 500, 502, 503, 504}
PERMANENT_STATUS_CODES = {400, 401, 403, 404, 409, 410, 413, 415, 422}
MAX_ATTEMPTS = int(os.environ.get("PUBLISH_MAX_ATTEMPTS", "4"))
BACKOFF_BASE_SECONDS = int(os.environ.get("PUBLISH_BACKOFF_BASE_SECONDS", "60"))
BACKOFF_MAX_SECONDS = int(os.environ.get("PUBLISH_BACKOFF_MAX_SECONDS", "3600"))

def classify_publish_error(error: Any) -> str:
    if isinstance(error, urllib.error.HTTPError):
        if error.code in TRANSIENT_STATUS_CODES:
            return "transient"
        if error.code in PERMANENT_STATUS_CODES:
            return "permanent"
    text = str(error or "").lower()
    if any(marker in text for marker in ("timeout", "timed out", "temporarily", "connection reset", "network", "502", "503", "504", "429")):
        return "transient"
    if any(marker in text for marker in ("401", "403", "unauthorized", "forbidden", "invalid token", "permission", "unsupported", "validation", "400")):
        return "permanent"
    return "unknown"


def next_retry_at(attempt_count: int) -> str:
    delay = min(BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * (2 ** max(0, attempt_count - 1)))
    return time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(time.time() + delay))


def normalize_publish_result(record: dict[str, Any] | None) -> tuple[str, str | None, list[Any] | None, str | None, str | None, int, str]:
    record = record if isinstance(record, dict) else {}
    ok = bool(record.get("ok"))
    skipped = bool(record.get("skipped"))
    status = "published" if ok else ("skipped" if skipped else "failed")
    external_id = record.get("id")
    external_ids = record.get("ids")
    if not external_id and isinstance(external_ids, list) and external_ids:
        external_id = str(external_ids[0])
    url = record.get("url")
    if not external_id and url:
        external_id = url
    if not url and isinstance(external_id, str) and external_id.startswith(("http://", "https://")):
        url = external_id
    error = record.get("error") or record.get("reason")
    if not ok and not skipped and "retryable" not in record:
        record = dict(record)
        record["retryable"] = classify_publish_error(error) == "transient"
    return status, str(external_id) if external_id is not None else None, external_ids, str(url) if url else None, str(error) if error else None, int(skipped), json.dumps(record, ensure_ascii=False)
