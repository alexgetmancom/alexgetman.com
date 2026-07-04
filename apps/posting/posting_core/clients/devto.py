from __future__ import annotations

import json

from posting_core.http_client import HttpRequestError, request, request_json
from posting_core.publish_config import DEVTO_API_KEY, log

DEVTO_BASE_HEADERS = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; alexgetman-posting/1.0; +https://alexgetman.com)",
}


def _devto_headers() -> dict[str, str]:
    return {**DEVTO_BASE_HEADERS, "api-key": DEVTO_API_KEY}


def publish_to_devto(
    title: str,
    body_markdown: str,
    canonical_url: str | None = None,
    tags: list[str] | None = None,
    main_image: str | None = None,
    published: bool = True,
) -> str | None:
    """
    Publish or create a draft article on dev.to.
    Returns the article URL on success, None on failure.

    canonical_url should point to the original post on alexgetman.com so
    search engines treat that as the authoritative source.
    """
    if not DEVTO_API_KEY:
        log("dev.to API key missing, skipping")
        return None

    # dev.to accepts max 4 tags, lowercase, no spaces
    clean_tags = []
    for t in (tags or []):
        clean = t.lower().replace(" ", "").replace("-", "")[:20]
        if clean:
            clean_tags.append(clean)
    clean_tags = clean_tags[:4]

    article: dict = {
        "title": title,
        "body_markdown": body_markdown,
        "published": published,
    }
    if canonical_url:
        article["canonical_url"] = canonical_url
    if main_image:
        article["main_image"] = main_image
    if clean_tags:
        article["tags"] = clean_tags

    try:
        data = request_json(
            "https://dev.to/api/articles",
            payload={"article": article},
            headers=_devto_headers(),
            method="POST",
            timeout=30,
        )
        url = data.get("url")
        log(f"dev.to article published: {url}")
        return url
    except HttpRequestError as exc:
        log(f"dev.to publish failed: {exc.status} {exc.body}")
        return None
    except Exception as exc:
        log(f"dev.to publish error: {exc}")
        return None


def update_devto_article(article_id: int, **kwargs) -> bool:
    """Update an existing dev.to article by ID."""
    if not DEVTO_API_KEY:
        return False
    try:
        request(
            f"https://dev.to/api/articles/{article_id}",
            data=json.dumps({"article": kwargs}).encode("utf-8"),
            headers=_devto_headers(),
            method="PUT",
            timeout=30,
        )
        return True
    except Exception as exc:
        log(f"dev.to update failed: {exc}")
        return False
