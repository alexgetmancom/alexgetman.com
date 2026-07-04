from __future__ import annotations

import re


def bluesky_public_url_from_uri(uri: str | None, handle: str = "alexgetmancom.bsky.social") -> str | None:
    if not uri or "/app.bsky.feed.post/" not in uri:
        return None
    rkey = uri.rsplit("/", 1)[-1]
    return f"https://bsky.app/profile/{handle}/post/{rkey}" if rkey else None


def target_public_url(target: str, external_id: str | None = None, url: str | None = None) -> str | None:
    if url:
        return url.replace("threads.net", "threads.com")
    if not external_id:
        return None
    if external_id.startswith(("http://", "https://")):
        return external_id
    if target == "bluesky":
        return bluesky_public_url_from_uri(external_id)
    if target == "x":
        return f"https://x.com/alexgetmancom/status/{external_id}"
    if target == "threads_ru":
        return f"https://www.threads.com/@alexgetmanru/post/{external_id}"
    if target == "threads_en":
        return f"https://www.threads.com/@alexgetmanco/post/{external_id}"
    if target == "linkedin":
        return "https://www.linkedin.com/feed/update/" + external_id
    if target in {"facebook", "facebook_ru"}:
        return "https://www.facebook.com/" + external_id
    if target == "mastodon":
        return external_id if external_id.startswith("https://") else None
    if target in {"devto", "github_en", "github_ru"}:
        return external_id if re.match(r"^https?://", external_id) else None
    return None

