from __future__ import annotations

import json
import urllib.request
import urllib.error

from posting_core.publish_config import DEVTO_API_KEY, log


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

    payload = json.dumps({"article": article}).encode()

    try:
        req = urllib.request.Request(
            "https://dev.to/api/articles",
            data=payload,
            headers={
                "api-key": DEVTO_API_KEY,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            url = data.get("url")
            log(f"dev.to article published: {url}")
            return url
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        log(f"dev.to publish failed: {exc.code} {body}")
        return None
    except Exception as exc:
        log(f"dev.to publish error: {exc}")
        return None


def update_devto_article(article_id: int, **kwargs) -> bool:
    """Update an existing dev.to article by ID."""
    if not DEVTO_API_KEY:
        return False
    payload = json.dumps({"article": kwargs}).encode()
    try:
        req = urllib.request.Request(
            f"https://dev.to/api/articles/{article_id}",
            data=payload,
            headers={
                "api-key": DEVTO_API_KEY,
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            },
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
            return True
    except Exception as exc:
        log(f"dev.to update failed: {exc}")
        return False
