from __future__ import annotations

import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI

import site_feed.render as render_module
from posting_core.db import connect, ensure_pipeline_schema
from posting_core.paths import get_paths
from site_feed.config import DATA_DIR
from site_feed.likes import init_likes_db
from site_feed.site_jobs import enqueue_site_job


@asynccontextmanager
async def site_feed_lifespan(app: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    paths = get_paths()
    if paths.pipeline_db.exists():
        with connect(paths.pipeline_db) as conn:
            ensure_pipeline_schema(conn)
            conn.commit()
    init_likes_db()
    render_module.RENDER_ASYNC_ENABLED = True
    threading.Thread(target=render_module.render_worker, daemon=True).start()
    enqueue_site_job(message_id=0, reason="startup_reconcile")
    render_module.RENDER_EVENT.set()
    yield
