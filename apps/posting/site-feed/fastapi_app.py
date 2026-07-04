#!/usr/bin/env python3
from __future__ import annotations

import argparse

import uvicorn
from fastapi import FastAPI

from site_feed.app_lifecycle import site_feed_lifespan
from site_feed.config import BIND_HOST, PORT
from site_feed.dashboard_routes import register_dashboard_routes
from site_feed.engagement_routes import register_engagement_routes
from site_feed.health_routes import register_health_routes
from site_feed.telegram_routes import register_telegram_routes
from site_feed.mcp_routes import register_mcp_routes


app = FastAPI(title="alexgetman-posting site-feed", lifespan=site_feed_lifespan)
register_health_routes(app)
register_dashboard_routes(app)
register_engagement_routes(app)
register_telegram_routes(app)
register_mcp_routes(app)


def main():
    parser = argparse.ArgumentParser(description="FastAPI site-feed for alexgetman.com")
    parser.add_argument("command", nargs="?", default="serve", choices=["serve"])
    args = parser.parse_args()
    if args.command == "serve":
        uvicorn.run(app, host=BIND_HOST, port=PORT, log_level="info")


if __name__ == "__main__":
    main()
