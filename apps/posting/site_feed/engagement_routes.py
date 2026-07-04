from __future__ import annotations

from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse

from site_feed.auth import client_ip_hash
from site_feed.likes import get_batch_likes, get_likes_info, toggle_like
from site_feed.metrics import metrics_dashboard, record_pageview


def register_engagement_routes(app: FastAPI) -> None:
    @app.get("/stats", response_class=HTMLResponse)
    async def stats_page():
        return metrics_dashboard()

    @app.get("/{path:path}.md")
    async def get_markdown_file(path: str):
        from site_feed.config import SITE_ROOT
        clean_path = path.strip("/")
        if ".." in clean_path:
            raise HTTPException(status_code=400, detail="Invalid path")
        file_path = SITE_ROOT / f"{clean_path}.md"
        if not file_path.exists():
            raise HTTPException(status_code=404, detail="File not found")
        record_pageview(f"/{clean_path}.md")
        return FileResponse(
            str(file_path),
            media_type="text/markdown",
            headers={"Content-Type": "text/markdown; charset=utf-8"}
        )

    @app.post("/stats/pageview")
    async def pageview(request: Request):
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        record_pageview(payload.get("path", "/"))
        return Response(status_code=204)

    @app.get("/api/likes")
    async def likes_get(request: Request, post_id: str | None = None):
        if not post_id:
            return JSONResponse({"error": "Missing post_id parameter"}, status_code=400)
        return get_likes_info(post_id.strip(), client_ip_hash(request))

    @app.get("/api/likes/batch")
    async def likes_batch(request: Request, ids: str | None = None):
        if not ids:
            return {}
        post_ids = [part.strip() for part in ids.split(",") if part.strip()]
        return get_batch_likes(post_ids, client_ip_hash(request))

    @app.post("/api/likes")
    async def likes_post(request: Request, post_id: str | None = None):
        if not post_id:
            return JSONResponse({"error": "Missing post_id parameter"}, status_code=400)
        return toggle_like(post_id.strip(), client_ip_hash(request))
