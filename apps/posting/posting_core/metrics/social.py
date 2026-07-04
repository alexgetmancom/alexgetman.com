from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
import asyncio

from posting_core.http_client import request_json
from posting_core.clients.instagram import get_instagram_media_fields, get_instagram_story_insights
from posting_core.metrics.repository import upsert_metric
from posting_core.metrics.schedule import finish_metric_task
from posting_core.metrics_config import (
    CHANNEL_USERNAME,
    GITHUB_DISCUSSIONS_TOKEN,
    TELEGRAM_CHANNEL_STORIES_API_HASH,
    TELEGRAM_CHANNEL_STORIES_API_ID,
    TELEGRAM_CHANNEL_STORIES_SESSION,
)
from posting_core.publish_config import DEVTO_API_KEY, INSTAGRAM_EN_ACCESS_TOKEN, INSTAGRAM_RU_ACCESS_TOKEN


DEVTO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; alexgetman-posting/1.0; +https://alexgetman.com)",
}


def _thread_ids(row) -> list[str]:
    ids = []
    raw = row["external_ids_json"] if "external_ids_json" in row.keys() else None
    if raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                ids.extend(str(item) for item in parsed if item)
        except Exception:
            pass
    if not ids and row["external_id"]:
        ids.append(str(row["external_id"]))
    return ids


def _upsert_many(conn, row, source: str, metrics: dict[str, int], raw: dict, error: str | None = None) -> None:
    if error:
        upsert_metric(conn, row["post_key"], row["target"], None, source, raw, error=error)
        finish_metric_task(conn, row["post_key"], row["target"], row["date_utc"], error=error)
        return
    for name, value in metrics.items():
        upsert_metric(conn, row["post_key"], row["target"], int(value), source, raw, metric_name=name)
    finish_metric_task(conn, row["post_key"], row["target"], row["date_utc"], error=None)


def _sync_bluesky(conn, row) -> None:
    uris = [item for item in _thread_ids(row) if item.startswith("at://")]
    if not uris:
        _upsert_many(conn, row, "bluesky_public_api", {}, {"external_id": row["external_id"]}, "missing_bluesky_uris")
        return
    query = urllib.parse.urlencode([("uris", uri) for uri in uris])
    data = request_json(f"https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?{query}", timeout=30)
    totals = {"likes": 0, "replies": 0, "reposts": 0, "quotes": 0}
    parts = []
    for post in data.get("posts", []) or []:
        part = {
            "uri": post.get("uri"),
            "likes": int(post.get("likeCount") or 0),
            "replies": int(post.get("replyCount") or 0),
            "reposts": int(post.get("repostCount") or 0),
            "quotes": int(post.get("quoteCount") or 0),
        }
        parts.append(part)
        for key in totals:
            totals[key] += part[key]
    _upsert_many(conn, row, "bluesky_public_api", totals, {"parts": parts, "ids": uris})


def _mastodon_id(value: str) -> str | None:
    value = str(value or "")
    match = re.search(r"/(\d+)(?:$|[?#])", value)
    if match:
        return match.group(1)
    return value if value.isdigit() else None


def _sync_mastodon(conn, row) -> None:
    ids = [_mastodon_id(item) for item in _thread_ids(row)]
    ids = [item for item in ids if item]
    if not ids:
        _upsert_many(conn, row, "mastodon_public_api", {}, {"external_id": row["external_id"]}, "missing_mastodon_status_ids")
        return
    totals = {"likes": 0, "replies": 0, "reposts": 0}
    parts = []
    for status_id in ids:
        data = request_json(f"https://mastodon.social/api/v1/statuses/{status_id}", timeout=30)
        part = {
            "id": status_id,
            "likes": int(data.get("favourites_count") or 0),
            "replies": int(data.get("replies_count") or 0),
            "reposts": int(data.get("reblogs_count") or 0),
        }
        parts.append(part)
        for key in totals:
            totals[key] += part[key]
    _upsert_many(conn, row, "mastodon_public_api", totals, {"parts": parts, "ids": ids})


def _sync_devto(conn, row) -> None:
    url = row["url"] or row["external_id"]
    match = re.search(r"dev\.to/([^/]+)/([^/?#]+)", str(url or ""))
    if not match:
        _upsert_many(conn, row, "devto_api", {}, {"url": url}, "missing_devto_article_path")
        return
    username, slug = match.groups()
    data, source = _fetch_devto_article_metrics(username, slug, str(url or ""))
    metrics = {
        "views": int(data.get("page_views_count") or 0),
        "likes": int(data.get("public_reactions_count") or data.get("positive_reactions_count") or 0),
        "replies": int(data.get("comments_count") or 0),
    }
    _upsert_many(conn, row, source, metrics, {"url": url, "api_id": data.get("id"), "slug": slug})


def _fetch_devto_article_metrics(username: str, slug: str, url: str) -> tuple[dict, str]:
    if DEVTO_API_KEY:
        headers = {**DEVTO_HEADERS, "api-key": DEVTO_API_KEY}
        page = 1
        while page <= 5:
            articles = request_json(
                "https://dev.to/api/articles/me",
                headers=headers,
                query={"per_page": 100, "page": page},
                timeout=30,
            )
            if not isinstance(articles, list) or not articles:
                break
            for article in articles:
                article_url = str(article.get("url") or "")
                article_slug = str(article.get("slug") or "")
                if article_slug == slug or article_url.rstrip("/") == url.rstrip("/"):
                    return article, "devto_api_authenticated"
            page += 1

    data = request_json(f"https://dev.to/api/articles/{username}/{slug}", headers=DEVTO_HEADERS, timeout=30)
    return data, "devto_api_public"


def _github_discussion_parts(url: str) -> tuple[str, str, int] | None:
    match = re.search(r"github\.com/([^/]+)/([^/]+)/discussions/(\d+)", str(url or ""))
    if not match:
        return None
    owner, repo, number = match.groups()
    return owner, repo, int(number)


def _sync_github(conn, row) -> None:
    if not GITHUB_DISCUSSIONS_TOKEN:
        _upsert_many(conn, row, "github_graphql", {}, {"url": row["url"] or row["external_id"]}, "missing_github_discussions_token")
        return
    parsed = _github_discussion_parts(row["url"] or row["external_id"])
    if not parsed:
        _upsert_many(conn, row, "github_graphql", {}, {"url": row["url"] or row["external_id"]}, "missing_github_discussion_url")
        return
    owner, repo, number = parsed
    payload = json.dumps({
        "query": """
        query($owner:String!, $repo:String!, $number:Int!) {
          repository(owner:$owner, name:$repo) {
            discussion(number:$number) {
              comments { totalCount }
              reactions { totalCount }
            }
          }
        }
        """,
        "variables": {"owner": owner, "repo": repo, "number": number},
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://api.github.com/graphql",
        data=payload,
        headers={
            "Authorization": f"Bearer {GITHUB_DISCUSSIONS_TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": "alexgetman-posting/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    discussion = (((data.get("data") or {}).get("repository") or {}).get("discussion") or {})
    metrics = {
        "likes": int(((discussion.get("reactions") or {}).get("totalCount")) or 0),
        "replies": int(((discussion.get("comments") or {}).get("totalCount")) or 0),
    }
    _upsert_many(conn, row, "github_graphql", metrics, {"url": row["url"] or row["external_id"], "number": number})


def _sync_instagram_story(conn, row) -> None:
    token = INSTAGRAM_RU_ACCESS_TOKEN if row["target"] == "instagram_stories_ru" else INSTAGRAM_EN_ACCESS_TOKEN
    if not token:
        _upsert_many(conn, row, "instagram_graph_api", {}, {"external_id": row["external_id"]}, "missing_instagram_story_token")
        return
    if not row["external_id"]:
        _upsert_many(conn, row, "instagram_graph_api", {}, {"target": row["target"]}, "missing_instagram_story_id")
        return
    data = get_instagram_story_insights(row["external_id"], token=token)
    values = {}
    for item in data.get("data") or []:
        name = item.get("name")
        raw_values = item.get("values") or []
        value = raw_values[0].get("value") if raw_values and isinstance(raw_values[0], dict) else 0
        try:
            values[name] = int(value or 0)
        except (TypeError, ValueError):
            values[name] = 0
    metrics = {
        "views": values.get("views", values.get("reach", 0)),
        "reach": values.get("reach", 0),
        "likes": 0,
        "replies": values.get("replies", 0),
        "reposts": values.get("shares", 0),
        "total_interactions": values.get("total_interactions", 0),
        "navigation": values.get("navigation", 0),
    }
    raw = {"insights": data}
    try:
        fields = get_instagram_media_fields(row["external_id"], "like_count,comments_count", token=token)
        metrics["likes"] = int(fields.get("like_count") or 0)
        raw["fields"] = fields
    except Exception as exc:
        raw["fields_error"] = str(exc)
    _upsert_many(conn, row, "instagram_graph_api", metrics, raw)


async def _fetch_telegram_story_metrics(story_id: int) -> dict:
    from telethon import TelegramClient, functions

    client = TelegramClient(
        TELEGRAM_CHANNEL_STORIES_SESSION,
        int(TELEGRAM_CHANNEL_STORIES_API_ID),
        TELEGRAM_CHANNEL_STORIES_API_HASH,
    )
    await client.connect()
    try:
        channel = await client.get_input_entity(CHANNEL_USERNAME)
        data = await client(functions.stories.GetStoriesByIDRequest(peer=channel, id=[story_id]))
        story = (data.stories or [None])[0]
        if not story:
            raise RuntimeError(f"telegram_story_not_found:{story_id}")
        views = getattr(story, "views", None)
        forwards = getattr(views, "forwards_count", 0) or 0
        reactions = getattr(views, "reactions_count", 0) or 0
        return {
            "metrics": {
                "views": getattr(views, "views_count", 0) or 0,
                "likes": reactions,
                "reposts": forwards,
                "replies": 0,
                "total_interactions": reactions + forwards,
            },
            "raw": {
                "story_id": story_id,
                "peer": CHANNEL_USERNAME,
                "views": {
                    "views_count": getattr(views, "views_count", 0) or 0,
                    "forwards_count": forwards,
                    "reactions_count": reactions,
                },
            },
        }
    finally:
        await client.disconnect()


def _sync_telegram_story(conn, row) -> None:
    if not TELEGRAM_CHANNEL_STORIES_API_ID or not TELEGRAM_CHANNEL_STORIES_API_HASH:
        _upsert_many(conn, row, "telegram_mtproto", {}, {"target": row["target"]}, "missing_telegram_channel_stories_api_credentials")
        return
    if not row["external_id"]:
        _upsert_many(conn, row, "telegram_mtproto", {}, {"target": row["target"]}, "missing_telegram_story_id")
        return
    data = asyncio.run(_fetch_telegram_story_metrics(int(row["external_id"])))
    _upsert_many(conn, row, "telegram_mtproto", data["metrics"], data["raw"])


def sync_other_social_metrics(conn, tasks) -> None:
    handlers = {
        "bluesky": _sync_bluesky,
        "mastodon": _sync_mastodon,
        "devto": _sync_devto,
        "github_en": _sync_github,
        "github_ru": _sync_github,
        "telegram_stories": _sync_telegram_story,
        "instagram_stories": _sync_instagram_story,
        "instagram_stories_ru": _sync_instagram_story,
    }
    for row in tasks:
        target = row["target"]
        handler = handlers.get(target)
        if not handler:
            if target in {"x", "linkedin"}:
                _upsert_many(conn, row, f"{target}_metrics", {}, {"target": target}, "metrics_not_implemented")
            continue
        try:
            handler(conn, row)
        except Exception as exc:
            _upsert_many(conn, row, f"{target}_metrics", {}, {"target": target, "external_id": row["external_id"]}, str(exc))
    conn.commit()
