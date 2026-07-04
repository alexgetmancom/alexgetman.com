#!/usr/bin/env python3
from __future__ import annotations

import time

from posting_core.controller.albums import finalize_pending_albums
from posting_core.controller.config import POLL_SECONDS, api, log
from posting_core.controller.db import db
from posting_core.controller.handlers import handle_business_connection, handle_callback, handle_message
from posting_core.controller.schedule import publish_due_scheduled_drafts


def main():
    with db():
        pass
    offset = 0
    log('controller bot started')
    while True:
        try:
            res = api('getUpdates', {'offset': offset, 'timeout': 20, 'allowed_updates': ['message', 'callback_query', 'business_connection']})
            for update in res.get('result', []):
                offset = max(offset, update['update_id'] + 1)
                if 'message' in update:
                    handle_message(update['message'])
                elif 'callback_query' in update:
                    handle_callback(update['callback_query'])
                elif 'business_connection' in update:
                    handle_business_connection(update['business_connection'])
            finalize_pending_albums()
            publish_due_scheduled_drafts()
        except Exception as exc:
            log(f'main loop error: {exc}')
            time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    main()
