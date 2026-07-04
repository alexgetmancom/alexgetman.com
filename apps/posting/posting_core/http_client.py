from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes


class HttpRequestError(Exception):
    def __init__(self, status: int, reason: str, body: str):
        self.status = status
        self.reason = reason
        self.body = body
        super().__init__(f"HTTP {status} {reason}: {body}")


def _with_query(url: str, query: dict | None) -> str:
    if not query:
        return url
    separator = "&" if "?" in url else "?"
    return url + separator + urllib.parse.urlencode(query)


def request(
    url: str,
    *,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    query: dict | None = None,
) -> HttpResponse:
    req = urllib.request.Request(_with_query(url, query), data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return HttpResponse(
                status=resp.status,
                headers=dict(resp.headers.items()),
                body=resp.read(),
            )
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", "ignore")
        raise HttpRequestError(err.code, err.reason, body) from err


def request_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    query: dict | None = None,
    empty_id_header: str | None = None,
) -> dict:
    req_headers = dict(headers or {})
    if payload is not None:
        req_headers.setdefault("Content-Type", "application/json")
        data = json.dumps(payload).encode("utf-8")
    resp = request(url, method=method, data=data, headers=req_headers, timeout=timeout, query=query)
    if not resp.body:
        if empty_id_header:
            rest_id = resp.headers.get(empty_id_header) or resp.headers.get(empty_id_header.lower())
            if rest_id:
                return {"id": rest_id}
        return {}
    return json.loads(resp.body.decode("utf-8"))


def request_text(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    timeout: int = 30,
    query: dict | None = None,
    max_bytes: int | None = None,
) -> str:
    resp = request(url, method=method, headers=headers, timeout=timeout, query=query)
    body = resp.body[:max_bytes] if max_bytes else resp.body
    return body.decode("utf-8", "ignore")
