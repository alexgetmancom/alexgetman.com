from __future__ import annotations

import json
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

from posting_core.publish_config import BLUESKY_HANDLE, BLUESKY_APP_PASSWORD, log

DEFAULT_BLUESKY_HANDLE = "alexgetmancom.bsky.social"


def bluesky_public_url(uri: str | None, handle: str | None = None) -> str | None:
    if not uri or "/app.bsky.feed.post/" not in uri:
        return None
    post_id = uri.rsplit("/", 1)[-1]
    profile = handle or BLUESKY_HANDLE or DEFAULT_BLUESKY_HANDLE
    if not post_id or not profile:
        return None
    return f"https://bsky.app/profile/{profile}/post/{post_id}"


def verify_bluesky_root_visible(uri: str | None, handle: str | None = None) -> tuple[bool, str | None]:
    if not uri or "/app.bsky.feed.post/" not in uri:
        return False, "missing_bluesky_uri"
    profile = handle or BLUESKY_HANDLE or DEFAULT_BLUESKY_HANDLE
    if not profile:
        return False, "missing_bluesky_handle"
    rkey = uri.rsplit("/", 1)[-1]
    url = (
        "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?"
        + urllib.parse.urlencode({"actor": profile, "limit": 30, "filter": "posts_no_replies"})
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "alexgetman-posting/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
        for item in data.get("feed", []):
            post_uri = str(((item.get("post") or {}).get("uri")) or "")
            if post_uri.rsplit("/", 1)[-1] == rkey:
                return True, "visible_in_author_feed"
        return False, "not_in_author_feed"
    except Exception as exc:
        return False, str(exc)


def _create_session() -> tuple[str, str] | None:
    """Authenticate and return (did, access_jwt)."""
    if not BLUESKY_HANDLE or not BLUESKY_APP_PASSWORD:
        log("Bluesky credentials missing")
        return None
    try:
        payload = json.dumps({
            "identifier": BLUESKY_HANDLE,
            "password": BLUESKY_APP_PASSWORD,
        }).encode()
        req = urllib.request.Request(
            "https://bsky.social/xrpc/com.atproto.server.createSession",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data["did"], data["accessJwt"]
    except Exception as exc:
        log(f"Bluesky auth failed: {exc}")
        return None


def _upload_image(access_jwt: str, file_path: str) -> dict | None:
    """Upload image blob, return blob dict."""
    file_path_str = str(file_path)
    try:
        with open(file_path_str, "rb") as f:
            image_data = f.read()
        # Detect mime type
        mime = "image/jpeg"
        if file_path_str.lower().endswith(".png"):
            mime = "image/png"
        elif file_path_str.lower().endswith(".webp"):
            mime = "image/webp"
        req = urllib.request.Request(
            "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
            data=image_data,
            headers={
                "Authorization": f"Bearer {access_jwt}",
                "Content-Type": mime,
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
            return data.get("blob")
    except Exception as exc:
        log(f"Bluesky image upload failed: {exc}")
        return None


def publish_to_bluesky(text: str, media_items: list, canonical_url: str | None = None) -> dict:
    """Publish a post or thread to Bluesky and return a normalized result."""
    if not BLUESKY_HANDLE or not BLUESKY_APP_PASSWORD:
        log("Bluesky credentials missing, skipping")
        return {"ok": False, "skipped": True, "error": "missing_bluesky_credentials"}

    session = _create_session()
    if not session:
        return {"ok": False, "error": "bluesky_auth_failed", "retryable": True}
    did, access_jwt = session

    from posting_core.text import grapheme_len, split_text
    parts = split_text(text, limit=300, length_func=grapheme_len)

    # Attach images (max 4 on Bluesky, only to first post)
    images = []
    for item in media_items:
        if item.get("type") != "IMAGE":
            continue
        local_path = item.get("local_path")
        if not local_path:
            continue
        blob = _upload_image(access_jwt, local_path)
        if blob:
            images.append({"alt": "", "image": blob})
        if len(images) >= 4:
            break

    first_uri = None
    root_post = None  # {"uri": str, "cid": str}
    parent_post = None  # {"uri": str, "cid": str}
    uris: list[str] = []
    urls: list[str] = []

    created_at_base = datetime.now(timezone.utc)

    for i, part in enumerate(parts):
        record: dict = {
            "$type": "app.bsky.feed.post",
            "text": part,
            "createdAt": (created_at_base + timedelta(seconds=i)).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
            "langs": ["ru", "en"],
        }
        # Embed images on the first post only
        if i == 0 and images:
            record["embed"] = {
                "$type": "app.bsky.embed.images",
                "images": images,
            }
        
        # Link reply to thread
        if parent_post and root_post:
            record["reply"] = {
                "root": root_post,
                "parent": parent_post
            }

        try:
            payload = json.dumps({
                "repo": did,
                "collection": "app.bsky.feed.post",
                "record": record,
            }).encode()
            req = urllib.request.Request(
                "https://bsky.social/xrpc/com.atproto.repo.createRecord",
                data=payload,
                headers={
                    "Authorization": f"Bearer {access_jwt}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                uri = data.get("uri")
                cid = data.get("cid")
                
                if i == 0:
                    first_uri = uri
                    root_post = {"uri": uri, "cid": cid}
                
                parent_post = {"uri": uri, "cid": cid}
                if uri:
                    uris.append(uri)
                    public = bluesky_public_url(uri)
                    if public:
                        urls.append(public)
                log(f"Bluesky post {i} published: {uri}")
        except urllib.error.HTTPError as exc:
            body = exc.read().decode(errors="replace")
            log(f"Bluesky publish failed on step {i}: {exc.code} {body}")
            if i == 0:
                return {"ok": False, "error": f"Bluesky API HTTP {exc.code}: {body}", "retryable": exc.code >= 500}
        except Exception as exc:
            log(f"Bluesky publish error on step {i}: {exc}")
            if i == 0:
                return {"ok": False, "error": str(exc), "retryable": True}

    return {
        "ok": bool(first_uri),
        "id": first_uri,
        "url": bluesky_public_url(first_uri),
        "ids": uris,
        "urls": urls,
        "retryable": False,
    }
