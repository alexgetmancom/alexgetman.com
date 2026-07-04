from __future__ import annotations

from posting_core.metrics_config import SITE_METRICS_JSON, load_json
from posting_core.metrics.repository import metric_value_from_paths, upsert_metric


def sync_site_metrics(conn):
    metrics = load_json(SITE_METRICS_JSON, {"days": {}})
    rows = conn.execute("SELECT post_key, message_id, site_ru_path, site_en_path FROM posts WHERE status = 'active'").fetchall()
    for row in rows:
        if row["site_ru_path"]:
            ru_paths = [row["site_ru_path"]]
            if row["message_id"]:
                for p in (f"/ru/posts/{row['message_id']}/", f"/posts/{row['message_id']}/"):
                    if p not in ru_paths:
                        ru_paths.append(p)
            upsert_metric(conn, row["post_key"], "site_ru", metric_value_from_paths(metrics, ru_paths), "local_metrics_json", {"paths": ru_paths})
            bot_ru_paths = [p.rstrip("/") + ".md" if p.endswith("/") else p + ".md" for p in ru_paths]
            upsert_metric(conn, row["post_key"], "site_ru", metric_value_from_paths(metrics, bot_ru_paths), "local_metrics_json", {"paths": bot_ru_paths}, metric_name="bot_views")
        if row["site_en_path"]:
            en_paths = [row["site_en_path"]]
            if row["message_id"]:
                for p in (f"/en/posts/{row['message_id']}/", f"/posts/{row['message_id']}/"):
                    if p not in en_paths:
                        en_paths.append(p)
            upsert_metric(conn, row["post_key"], "site_en", metric_value_from_paths(metrics, en_paths), "local_metrics_json", {"paths": en_paths})
            bot_en_paths = [p.rstrip("/") + ".md" if p.endswith("/") else p + ".md" for p in en_paths]
            upsert_metric(conn, row["post_key"], "site_en", metric_value_from_paths(metrics, bot_en_paths), "local_metrics_json", {"paths": bot_en_paths}, metric_name="bot_views")
    conn.commit()
