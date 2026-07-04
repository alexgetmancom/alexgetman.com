from __future__ import annotations

import html
import re

from posting_core.http_client import request_text
from posting_core.metrics_config import CHANNEL_USERNAME, TELEGRAM_TIMEOUT_SECONDS, log
from posting_core.metrics.repository import upsert_metric
from posting_core.metrics.schedule import finish_metric_task


def parse_view_count(value):
    value = html.unescape((value or "").strip()).replace(" ", "")
    mult = 1
    if value.lower().endswith("k"):
        mult = 1000
        value = value[:-1]
    elif value.lower().endswith("m"):
        mult = 1000000
        value = value[:-1]
    value = value.replace(",", ".")
    try:
        return int(float(value) * mult)
    except Exception:
        return None


def fetch_telegram_metrics(message_ids):
    if not message_ids:
        return {}
    url = f"https://t.me/s/{CHANNEL_USERNAME}"
    data = request_text(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=TELEGRAM_TIMEOUT_SECONDS, max_bytes=400000)
    result = {}
    for mid in message_ids:
        section = re.search(rf"data-post=\"{re.escape(CHANNEL_USERNAME)}/{int(mid)}\"[\s\S]*?(?=data-post=\"{re.escape(CHANNEL_USERNAME)}/|</section>|$)", data)
        if not section:
            continue
        
        metrics = {}
        
        # 1. Views
        view_match = re.search(r"tgme_widget_message_views[^>]*>([^<]+)<", section.group(0))
        if view_match:
            parsed_views = parse_view_count(view_match.group(1))
            if parsed_views is not None:
                metrics["views"] = parsed_views

        # 2. Likes (Reactions sum)
        # Structure: <span class="tgme_reaction"><i class="emoji" ...><b>❤</b></i>3</span>
        # Or sometimes just multiple spans with reaction counts. We match anything after </i> inside the span class="tgme_reaction"
        reaction_matches = re.findall(r'class="tgme_reaction"[^>]*>.*?</i>([^<]+)', section.group(0))
        total_likes = 0
        has_reactions = False
        for val in reaction_matches:
            parsed_r = parse_view_count(val)
            if parsed_r is not None:
                total_likes += parsed_r
                has_reactions = True
        
        if has_reactions:
            metrics["likes"] = total_likes
        else:
            # If post exists but has no reactions (or reactions disabled/none yet), we default to 0
            metrics["likes"] = 0
            
        result[int(mid)] = metrics
    return result


def sync_telegram_metrics(conn, tasks):
    rows = [task for task in tasks if task["target"] == "telegram"]
    if not rows:
        return
    try:
        metrics_map = fetch_telegram_metrics([row["message_id"] for row in rows])
    except Exception as exc:
        error = f"Telegram metrics fetch failed: {exc}"
        log(error)
        for row in rows:
            finish_metric_task(conn, row["post_key"], "telegram", row["date_utc"], error=error)
        conn.commit()
        return
    for row in rows:
        post_metrics = metrics_map.get(int(row["message_id"]))
        if post_metrics:
            views_val = post_metrics.get("views")
            likes_val = post_metrics.get("likes")
            if views_val is not None:
                upsert_metric(conn, row["post_key"], "telegram", views_val, "t_me_public", {"message_id": int(row["message_id"])}, metric_name="views")
            if likes_val is not None:
                upsert_metric(conn, row["post_key"], "telegram", likes_val, "t_me_public", {"message_id": int(row["message_id"])}, metric_name="likes")
            
            finish_metric_task(conn, row["post_key"], "telegram", row["date_utc"], error=None if views_val is not None else "telegram_views_not_found")
        else:
            finish_metric_task(conn, row["post_key"], "telegram", row["date_utc"], error="telegram_views_not_found")
    conn.commit()
