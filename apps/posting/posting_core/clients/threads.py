from __future__ import annotations

from posting_core.http_client import HttpRequestError, request_json
from posting_core.publish_config import ENABLE_THREADS, THREADS_ACCESS_TOKEN, THREADS_CONTAINER_TIMEOUT_SECONDS, log, time
from posting_core.state import plan_target_enabled
from posting_core.text import split_text


def _is_threads_missing_media_error(error) -> bool:
    message = str(error)
    return (
        "Threads API HTTP 400" in message
        and '"code":24' in message
        and '"error_subcode":4279009' in message
    )


def publish_threads_container(container_id, token=None, label="threads", attempts=3):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return call_threads("me/threads_publish", {"creation_id": container_id}, token=token)
        except Exception as exc:
            last_error = exc
            if not _is_threads_missing_media_error(exc) or attempt >= attempts:
                raise
            delay = min(2 * attempt, 5)
            log(
                f"[{label}] Threads publish could not see container {container_id} yet; "
                f"retrying in {delay}s ({attempt}/{attempts})"
            )
            time.sleep(delay)
    raise last_error


def call_threads(endpoint, payload, method="POST", token=None):
    url = f"https://graph.threads.net/v1.0/{endpoint}"
    payload["access_token"] = token or THREADS_ACCESS_TOKEN

    try:
        if method == "GET":
            return request_json(url, method="GET", query=payload, timeout=30)
        return request_json(url, method="POST", payload=payload, headers={"Content-Type": "application/json"}, timeout=30)
    except HttpRequestError as err:
        log(f"HTTPError in call_threads: {err.status} {err.reason}. Response body: {err.body}")
        raise Exception(f"Threads API HTTP {err.status}: {err.body}")


def wait_for_container(cid, timeout_seconds=THREADS_CONTAINER_TIMEOUT_SECONDS, token=None):
    log(f"Waiting for container {cid} to finish processing...")
    deadline = time.monotonic() + timeout_seconds
    while True:
        if time.monotonic() >= deadline:
            raise Exception(f"Container {cid} timed out after {timeout_seconds}s")
        try:
            res = call_threads(cid, {"fields": "status,error_message"}, method="GET", token=token)
            status = res.get("status")
            log(f"Container {cid} status: {status}")
            if status == "FINISHED":
                return True
            if status == "ERROR":
                err = res.get("error_message", "Unknown error")
                raise Exception(f"Container {cid} failed: {err}")
            if status == "EXPIRED":
                raise Exception(f"Container {cid} expired.")
        except Exception as exc:
            msg = str(exc)
            if "failed:" in msg or "expired" in msg or "timed out" in msg:
                raise
            log(f"Error checking status for {cid}: {exc}")
        time.sleep(2)


def publish_to_threads_target(text_content, current_media_items, plan, token, label):
    local_published_ids = []
    local_child_ids = []
    if not (ENABLE_THREADS and token and plan_target_enabled(plan, label, True)):
        log(f"Threads publishing is disabled or token missing for target {label}")
        return {"ok": False, "skipped": True}
    log(f"Async target start: {label}")
    try:
        partial_error = None
        parts_to_publish = split_text(text_content, limit=480)
        if len(current_media_items) > 1:
            for item in current_media_items:
                child_payload = {
                    "media_type": item["type"],
                    "is_carousel_item": True,
                }
                if item["type"] == "VIDEO":
                    child_payload["video_url"] = item["vps_url"]
                else:
                    child_payload["image_url"] = item["vps_url"]

                log(f"[{label}] Staging child container (type: {item['type']})...")
                container = call_threads("me/threads", child_payload, token=token)
                local_child_ids.append(container["id"])

            for cid in local_child_ids:
                wait_for_container(cid, token=token)

            parent_payload = {
                "media_type": "CAROUSEL",
                "text": parts_to_publish[0],
                "children": local_child_ids,
            }
            log(f"[{label}] Staging parent Carousel container with {len(local_child_ids)} items...")
            container = call_threads("me/threads", parent_payload, token=token)
            container_id = container["id"]
            wait_for_container(container_id, token=token)

        elif len(current_media_items) == 1:
            item = current_media_items[0]
            first_payload = {
                "media_type": item["type"],
                "text": parts_to_publish[0],
            }
            if item["type"] == "VIDEO":
                first_payload["video_url"] = item["vps_url"]
            else:
                first_payload["image_url"] = item["vps_url"]

            log(f"[{label}] Staging single {item['type']} container...")
            container = call_threads("me/threads", first_payload, token=token)
            container_id = container["id"]
            wait_for_container(container_id, token=token)
        else:
            first_payload = {
                "media_type": "TEXT",
                "text": parts_to_publish[0],
            }
            log(f"[{label}] Staging text-only container...")
            container = call_threads("me/threads", first_payload, token=token)
            container_id = container["id"]
            wait_for_container(container_id, token=token)

        log(f"[{label}] Publishing main container {container_id}...")
        publish = publish_threads_container(container_id, token=token, label=label)
        last_id = publish["id"]
        local_published_ids.append(last_id)
        log(f"[{label}] Published main post ID: {last_id}")

        for i, part in enumerate(parts_to_publish[1:], start=1):
            log(f"[{label}] Staging reply post {i}: '{part[:50]}...'")
            reply_payload = {
                "media_type": "TEXT",
                "text": part,
                "reply_to_id": last_id,
            }
            container = call_threads("me/threads", reply_payload, token=token)
            container_id = container["id"]
            wait_for_container(container_id, token=token)

            log(f"[{label}] Publishing reply container {container_id}...")
            try:
                publish = publish_threads_container(container_id, token=token, label=label)
            except Exception as reply_exc:
                if local_published_ids and _is_threads_missing_media_error(reply_exc):
                    partial_error = str(reply_exc)
                    log(f"[{label}] Reply publish failed after root post was published; keeping root as published: {reply_exc}")
                    break
                raise
            last_id = publish["id"]
            local_published_ids.append(last_id)
            log(f"[{label}] Published reply ID: {last_id}")
            
        # Fetch permalink immediately
        permalink = None
        if local_published_ids:
            try:
                res_p = call_threads(local_published_ids[0], {"fields": "permalink"}, method="GET", token=token)
                permalink = res_p.get("permalink")
                if permalink:
                    permalink = permalink.replace("threads.net", "threads.com")
            except Exception as p_exc:
                log(f"[{label}] Failed to fetch permalink immediately: {p_exc}")

        result = {
            "ok": True,
            "id": local_published_ids[0] if local_published_ids else None,
            "ids": local_published_ids,
            "url": permalink,
            "urls": [permalink] if permalink else [],
            "retryable": False,
        }
        if partial_error:
            result["partial"] = True
            result["error"] = partial_error
        return result
    except Exception as exc:
        if local_published_ids:
            permalink = None
            try:
                res_p = call_threads(local_published_ids[0], {"fields": "permalink"}, method="GET", token=token)
                permalink = res_p.get("permalink")
                if permalink:
                    permalink = permalink.replace("threads.net", "threads.com")
            except Exception as p_exc:
                log(f"[{label}] Failed to fetch permalink for partially published root: {p_exc}")
            log(f"Threads ({label}) root post is already published; returning partial success after error: {exc}")
            return {
                "ok": True,
                "partial": True,
                "id": local_published_ids[0],
                "ids": local_published_ids,
                "url": permalink,
                "urls": [permalink] if permalink else [],
                "error": str(exc),
                "retryable": False,
            }
        log(f"Error publishing to Threads ({label}): {exc}")
        return {"ok": False, "error": str(exc)}
