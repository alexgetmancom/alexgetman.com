from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse

from site_feed.config import PIPELINE_DB
from site_feed.site_jobs import latest_site_build_status


def register_health_routes(app: FastAPI) -> None:
    @app.get("/tg-feed/healthz", response_class=PlainTextResponse)
    async def healthz():
        return "ok\n"

    @app.get("/healthz", response_class=PlainTextResponse)
    async def app_healthz():
        return "ok\n"

    @app.get("/readyz")
    async def readyz():
        build = latest_site_build_status()
        return {
            "ok": build.get("status") != "failed",
            "pipeline_db": PIPELINE_DB.exists(),
            "site_build": build,
        }
