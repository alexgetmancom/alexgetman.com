from __future__ import annotations

import json

from posting_core.http_client import HttpRequestError, request_json
from posting_core.metrics_config import THREADS_ACCESS_TOKEN, THREADS_EN_ACCESS_TOKEN, THREADS_METRICS, log, now_iso
from posting_core.metrics.repository import upsert_metric
from posting_core.metrics.schedule import finish_metric_task


def fetch_threads_insights(threads_id, token=None):
    use_token = token or THREADS_ACCESS_TOKEN
    if not use_token or not threads_id:
        return None, "missing_threads_token_or_id"
    url = f"https://graph.threads.net/v1.0/{threads_id}/insights"
    try:
        data = request_json(
            url,
            query={
                "metric": THREADS_METRICS,
                "access_token": use_token,
            },
            timeout=30,
        )
        metrics = {}
        for item in data.get("data", []):
            name = item.get("name")
            values = item.get("values") or []
            if name and values:
                value = values[0].get("value")
                if value is not None:
                    metrics[name] = int(value)
        return metrics, None
    except HttpRequestError as err:
        return None, f"Threads API HTTP {err.status}: {err.body[:300]}"
    except Exception as exc:
        return None, str(exc)


def fetch_threads_permalink(threads_id, token):
    if not token or not threads_id:
        return None, "missing_threads_token_or_id"
    url = f"https://graph.threads.net/v1.0/{threads_id}"
    try:
        data = request_json(
            url,
            query={
                "fields": "permalink",
                "access_token": token,
            },
            timeout=30,
        )
        return data.get("permalink"), None
    except HttpRequestError as err:
        return None, f"Threads API HTTP {err.status}: {err.body[:300]}"
    except Exception as exc:
        return None, str(exc)


def sync_threads_metrics(conn, tasks):
    rows = [task for task in tasks if task["target"] in ("threads_ru", "threads_en") and task["external_id"]]
    if not rows:
        return
    for row in rows:
        target = row["target"]
        token = THREADS_EN_ACCESS_TOKEN if target == "threads_en" else THREADS_ACCESS_TOKEN

        if not row["url"]:
            permalink, p_err = fetch_threads_permalink(row["external_id"], token=token)
            if permalink:
                permalink = permalink.replace("threads.net", "threads.com")
                conn.execute(
                    """
                    UPDATE post_targets
                    SET url = ?, updated_at = ?
                    WHERE post_key = ? AND target = ?
                    """,
                    (permalink, now_iso(), row["post_key"], target),
                )
                log(f"Updated Threads permalink for {row['post_key']} ({target}): {permalink}")
            elif p_err:
                log(f"Warning: failed to fetch Threads permalink for {row['post_key']} ({target}): {p_err}")

        ids = []
        if row["external_ids_json"]:
            try:
                parsed = json.loads(row["external_ids_json"])
                if isinstance(parsed, list):
                    ids = [str(item) for item in parsed if item]
            except Exception:
                ids = []
        ids = ids or [row["external_id"]]

        totals = {}
        parts = []
        errors = []
        for threads_id in ids:
            metrics, error = fetch_threads_insights(threads_id, token=token)
            if error:
                errors.append({"id": threads_id, "error": error})
                continue
            part = {"id": threads_id, "metrics": metrics or {}}
            parts.append(part)
            for metric_name, value in (metrics or {}).items():
                target_metric = "views" if metric_name == "views" else metric_name
                totals[target_metric] = totals.get(target_metric, 0) + int(value)

        if not totals:
            error = "; ".join(item["error"] for item in errors) or "threads_metrics_empty"
            upsert_metric(conn, row["post_key"], target, None, "threads_insights_api", {"ids": ids, "errors": errors}, error=error)
            finish_metric_task(conn, row["post_key"], target, row["date_utc"], error=error)
            continue
        for target_metric, value in totals.items():
            sampled_at = now_iso()
            conn.execute(
                """
                INSERT INTO post_metrics(post_key, target, metric_name, value, source, sampled_at, error, raw_json)
                VALUES (?, ?, ?, ?, 'threads_insights_api', ?, NULL, ?)
                ON CONFLICT(post_key, target, metric_name) DO UPDATE SET
                    value=excluded.value,
                    source=excluded.source,
                    sampled_at=excluded.sampled_at,
                    error=NULL,
                    raw_json=excluded.raw_json
                """,
                (row["post_key"], target, target_metric, int(value), sampled_at, json.dumps({"ids": ids, "parts": parts, "errors": errors, "api_metric": target_metric}, ensure_ascii=False)),
            )
            conn.execute(
                "INSERT INTO metric_samples(post_key, target, metric_name, value, sampled_at, source, raw_json) VALUES (?, ?, ?, ?, ?, 'threads_insights_api', ?)",
                (row["post_key"], target, target_metric, int(value), sampled_at, json.dumps({"ids": ids, "parts": parts, "errors": errors, "api_metric": target_metric}, ensure_ascii=False)),
            )
        finish_metric_task(conn, row["post_key"], target, row["date_utc"], error=None)
    conn.commit()
