#!/usr/bin/env python3
from __future__ import annotations

import argparse

from site_feed.bot_source import sync_bot_source
from site_feed.render import render_site
from site_feed.telegram import set_webhook, webhook_info


def main():
    parser = argparse.ArgumentParser(description="Лента Telegram для alexgetman.com")
    parser.add_argument("command", choices=["render", "sync-bot-source", "set-webhook", "webhook-info"])
    args = parser.parse_args()

    if args.command == "render":
        render_site()
    elif args.command == "sync-bot-source":
        sync_bot_source()
    elif args.command == "set-webhook":
        set_webhook()
    elif args.command == "webhook-info":
        webhook_info()


if __name__ == "__main__":
    main()
