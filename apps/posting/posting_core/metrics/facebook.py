from __future__ import annotations

import json

from posting_core.http_client import request_json
from posting_core.metrics_config import FACEBOOK_GRAPH_API_VERSION, FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_RU_PAGE_ACCESS_TOKEN, now_iso, log
from posting_core.metrics.repository import upsert_metric
from posting_core.metrics.schedule import finish_metric_task


def fetch_facebook_insights(post_id, token=None):
    use_token = token or FACEBOOK_PAGE_ACCESS_TOKEN
    if not use_token or not post_id:
        return None, "missing_facebook_token_or_id"

    url_insights = f"https://graph.facebook.com/{FACEBOOK_GRAPH_API_VERSION}/{post_id}/insights"
    url_fields = f"https://graph.facebook.com/{FACEBOOK_GRAPH_API_VERSION}/{post_id}"

    metrics = {}
    errors = []

    try:
        data = request_json(
            url_insights,
            query={
                "metric": "post_total_media_view_unique",
                "period": "lifetime",
                "access_token": use_token,
            },
            timeout=30,
        )
        for item in data.get("data", []):
            if item.get("name") == "post_total_media_view_unique":
                values = item.get("values") or []
                if values:
                    metrics["views"] = int(values[0].get("value") or 0)
    except Exception as exc:
        log(f"Warning: failed to fetch Facebook insights for {post_id}: {exc}")
        errors.append(f"post insights: {exc}")

    try:
        data = request_json(
            url_fields,
            query={
                "fields": "reactions.summary(total_count),comments.summary(total_count),shares",
                "access_token": use_token,
            },
            timeout=30,
        )
        reactions = data.get("reactions") or {}
        metrics["likes"] = int((reactions.get("summary") or {}).get("total_count") or 0)
        comments = data.get("comments") or {}
        metrics["replies"] = int((comments.get("summary") or {}).get("total_count") or 0)
        metrics["reposts"] = int((data.get("shares") or {}).get("count") or 0)
    except Exception as exc:
        log(f"Facebook post fields failed for {post_id}; trying video edges: {exc}")
        errors.append(f"post fields: {exc}")
        try:
            data = request_json(
                f"{url_fields}/likes",
                query={
                    "summary": "total_count",
                    "limit": 0,
                    "access_token": use_token,
                },
                timeout=30,
            )
            metrics["likes"] = int((data.get("summary") or {}).get("total_count") or 0)
        except Exception as likes_exc:
            errors.append(f"video likes: {likes_exc}")
        try:
            data = request_json(
                f"{url_fields}/comments",
                query={
                    "summary": "total_count",
                    "limit": 0,
                    "access_token": use_token,
                },
                timeout=30,
            )
            metrics["replies"] = int((data.get("summary") or {}).get("total_count") or 0)
        except Exception as comments_exc:
            errors.append(f"video comments: {comments_exc}")

    if "views" not in metrics:
        for api_metric, extra_query in (
            ("fb_reels_total_plays", {}),
            ("total_video_views", {"period": "lifetime"}),
        ):
            try:
                data = request_json(
                    f"{url_fields}/video_insights",
                    query={
                        "metric": api_metric,
                        "access_token": use_token,
                        **extra_query,
                    },
                    timeout=30,
                )
                for item in data.get("data", []):
                    if item.get("name") != api_metric:
                        continue
                    values = item.get("values") or []
                    if values:
                        metrics["views"] = int(values[-1].get("value") or 0)
                        break
            except Exception as video_views_exc:
                errors.append(f"{api_metric}: {video_views_exc}")
            if "views" in metrics:
                break

    if not metrics:
        return None, "Facebook metrics failed: " + "; ".join(errors)

    return metrics, None


def sync_facebook_metrics(conn, tasks):
    for target in ("facebook", "facebook_ru"):
        rows = [task for task in tasks if task["target"] == target and task["external_id"]]
        if not rows:
            continue
        token = FACEBOOK_PAGE_ACCESS_TOKEN if target == "facebook" else FACEBOOK_RU_PAGE_ACCESS_TOKEN
        for row in rows:
            metrics, error = fetch_facebook_insights(row["external_id"], token=token)
            if error:
                upsert_metric(conn, row["post_key"], target, None, "facebook_insights_api", {"external_id": row["external_id"]}, error=error)
                finish_metric_task(conn, row["post_key"], target, row["date_utc"], error=error)
                continue
            for metric_name, value in (metrics or {}).items():
                sampled_at = now_iso()
                conn.execute(
                    f"""
                    INSERT INTO post_metrics(post_key, target, metric_name, value, source, sampled_at, error, raw_json)
                    VALUES (?, '{target}', ?, ?, 'facebook_insights_api', ?, NULL, ?)
                    ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
                        value=excluded.value,
                        source=excluded.source,
                        sampled_at=excluded.sampled_at,
                        error=NULL,
                        raw_json=excluded.raw_json
                    """,
                    (row["post_key"], metric_name, int(value), sampled_at, json.dumps({"external_id": row["external_id"], "api_metric": metric_name}, ensure_ascii=False)),
                )
                conn.execute(
                    f"INSERT INTO metric_samples(post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, '{target}', ?, ?, ?, 'facebook_insights_api', ?)",
                    (row["post_key"], metric_name, int(value), sampled_at, json.dumps({"external_id": row["external_id"], "api_metric": metric_name}, ensure_ascii=False)),
                )
            finish_metric_task(conn, row["post_key"], target, row["date_utc"], error=None)
    conn.commit()
