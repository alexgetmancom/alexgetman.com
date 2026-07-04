from __future__ import annotations

import os

from posting_core.publish_config import X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET, X_CONSUMER_KEY, X_CONSUMER_SECRET, log
from posting_core.text import strip_urls

def upload_x_media_chunked(file_path, auth, media_type="video/mp4", media_category="tweet_video"):
    import os
    import time
    import requests
    
    file_size = os.path.getsize(file_path)
    upload_url = "https://upload.twitter.com/1.1/media/upload.json"
    
    # 1. INIT
    log(f"X Media Chunked Upload [INIT] for size {file_size} bytes...")
    init_data = {
        "command": "INIT",
        "total_bytes": file_size,
        "media_type": media_type,
        "media_category": media_category
    }
    res = requests.post(upload_url, auth=auth, data=init_data, timeout=30)
    if not (200 <= res.status_code < 300):
        raise Exception(f"X INIT failed: {res.status_code} {res.text}")
    
    media_data = res.json()
    media_id_str = media_data["media_id_string"]
    log(f"X Media ID allocated: {media_id_str}")
    
    # 2. APPEND
    chunk_size = 2 * 1024 * 1024  # 2MB chunks
    segment_index = 0
    
    with open(file_path, "rb") as f:
        while True:
            chunk_data = f.read(chunk_size)
            if not chunk_data:
                break
                
            log(f"X Media Chunked Upload [APPEND] chunk {segment_index} ({len(chunk_data)} bytes)...")
            append_data = {
                "command": "APPEND",
                "media_id": media_id_str,
                "segment_index": segment_index
            }
            files = {"media": chunk_data}
            res = requests.post(upload_url, auth=auth, data=append_data, files=files, timeout=60)
            if not (200 <= res.status_code < 300):
                raise Exception(f"X APPEND chunk {segment_index} failed: {res.status_code} {res.text}")
                
            segment_index += 1
            
    # 3. FINALIZE
    log("X Media Chunked Upload [FINALIZE]...")
    finalize_data = {
        "command": "FINALIZE",
        "media_id": media_id_str
    }
    res = requests.post(upload_url, auth=auth, data=finalize_data, timeout=30)
    if not (200 <= res.status_code < 300):
        raise Exception(f"X FINALIZE failed: {res.status_code} {res.text}")
        
    finalize_res = res.json()
    
    # 4. STATUS check (only if processing_info is in response)
    processing_info = finalize_res.get("processing_info")
    if processing_info:
        state = processing_info.get("state")
        log(f"X Media processing state: {state}")
        
        while state in ("pending", "in_progress"):
            check_after_secs = processing_info.get("check_after_secs", 5)
            log(f"Waiting {check_after_secs} seconds for X video processing...")
            time.sleep(check_after_secs)
            
            status_params = {
                "command": "STATUS",
                "media_id": media_id_str
            }
            res = requests.get(upload_url, auth=auth, params=status_params, timeout=30)
            if not (200 <= res.status_code < 300):
                raise Exception(f"X STATUS check failed: {res.status_code} {res.text}")
                
            status_res = res.json()
            processing_info = status_res.get("processing_info") or {}
            state = processing_info.get("state")
            log(f"X Media processing state update: {state}")
            
            if state == "failed":
                error_info = processing_info.get("error", {})
                raise Exception(f"X video processing failed: {error_info.get('message', 'Unknown error')}")
                
    log("X Media upload and processing completed successfully.")
    return media_id_str


def publish_to_x(text, media_items):
    if not X_CONSUMER_KEY or not X_CONSUMER_SECRET or not X_ACCESS_TOKEN or not X_ACCESS_TOKEN_SECRET:
        log("X/Twitter credentials missing")
        return None
        
    try:
        import requests
        from requests_oauthlib import OAuth1
    except ImportError:
        log("Error: requests or requests-oauthlib not installed")
        return None
        
    auth = OAuth1(X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)
    text = strip_urls(text)
    
    media_ids = []
    try:
        # 1. Загрузка медиа (если есть)
        for item in media_items:
            file_path = item.get("local_path")
            if not file_path or not os.path.exists(file_path):
                log(f"Local file for X upload not found: {file_path}")
                continue
                
            item_type = item.get("type")
            try:
                if item_type == "VIDEO":
                    media_id_str = upload_x_media_chunked(file_path, auth, media_type="video/mp4", media_category="amplify_video")
                else:
                    log(f"Uploading image to X: {file_path}")
                    upload_url = "https://upload.twitter.com/1.1/media/upload.json"
                    with open(file_path, "rb") as f:
                        files = {"media": f}
                        res = requests.post(upload_url, auth=auth, files=files, timeout=60)
                        
                    if res.status_code not in (200, 201):
                        log(f"X media upload failed: {res.status_code} {res.text}")
                        continue
                    media_data = res.json()
                    media_id_str = media_data.get("media_id_string")
                
                if media_id_str:
                    media_ids.append(media_id_str)
                    log(f"Uploaded X media ID: {media_id_str}")
            except Exception as exc:
                log(f"Failed to upload media to X ({item_type}): {exc}")
                
        # 2. Создание твита
        tweet_url = "https://api.twitter.com/2/tweets"
        payload = {"text": text}
        if media_ids:
            payload["media"] = {"media_ids": media_ids}
            
        log("Creating tweet on X...")
        res = requests.post(tweet_url, auth=auth, json=payload, timeout=30)
        if res.status_code in (200, 201):
            tweet_data = res.json()
            tweet_id = tweet_data.get("data", {}).get("id")
            log(f"X tweet published successfully: {tweet_id}")
            return tweet_id
        else:
            log(f"Failed to create tweet: {res.status_code} {res.text}")
            return None
            
    except Exception as exc:
        log(f"Error publishing to X: {exc}")
        return None
