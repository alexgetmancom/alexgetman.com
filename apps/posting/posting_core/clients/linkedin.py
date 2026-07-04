from __future__ import annotations

import time
import urllib.parse

from posting_core.http_client import HttpRequestError, request, request_json
from posting_core.publish_config import LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN, log
from posting_core.text import strip_leading_emojis

def upload_linkedin_binary(upload_url, file_path):
    with open(file_path, "rb") as f:
        data = f.read()
    resp = request(
        upload_url,
        data=data,
        headers={"Content-Type": "application/octet-stream"},
        method="PUT",
        timeout=60,
    )
    return resp.status == 200 or resp.status == 201


def upload_linkedin_image(local_path):
    init_payload = {
        "initializeUploadRequest": {
            "owner": LINKEDIN_AUTHOR_URN
        }
    }
    res = call_linkedin("rest/images?action=initializeUpload", init_payload)
    value = res.get("value") or {}
    upload_url = value.get("uploadUrl")
    if not upload_url:
        upload_instructions = value.get("uploadInstructions") or []
        if upload_instructions:
            upload_url = upload_instructions[0].get("uploadUrl")
    media_urn = value["image"]
    if not upload_url:
        raise Exception(f"LinkedIn image initializeUpload did not return uploadUrl: {value}")

    log("Uploading image binary to LinkedIn...")
    success = upload_linkedin_binary(upload_url, local_path)
    if not success:
        raise Exception("Failed to upload binary to LinkedIn")
    return media_urn


def upload_linkedin_chunk(upload_url, chunk_data):
    try:
        resp = request(
            upload_url,
            data=chunk_data,
            headers={"Content-Type": "application/octet-stream"},
            method="PUT",
            timeout=60,
        )
    except HttpRequestError as err:
        log(f"HTTPError uploading chunk: {err.status} {err.reason}. Response body: {err.body}")
        raise Exception(f"LinkedIn Chunk Upload HTTP {err.status}: {err.body}")
    etag = resp.headers.get("ETag") or resp.headers.get("etag")
    if not etag:
        raise Exception("ETag header not found in chunk upload response")
    return etag


def call_linkedin(endpoint, payload, method="POST"):
    url = f"https://api.linkedin.com/{endpoint}"
    headers = {
        "Authorization": f"Bearer {LINKEDIN_ACCESS_TOKEN}",
        "Linkedin-Version": "202606",
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json"
    }
    
    try:
        return request_json(
            url,
            method=method,
            payload=payload,
            headers=headers,
            timeout=30,
            empty_id_header="x-restli-id",
        )
    except HttpRequestError as err:
        log(f"HTTPError in call_linkedin: {err.status} {err.reason}. Response body: {err.body}")
        raise Exception(f"LinkedIn API HTTP {err.status}: {err.body}")


def publish_to_linkedin(text, media_items):
    if not LINKEDIN_ACCESS_TOKEN or not LINKEDIN_AUTHOR_URN:
        return None
        
    log("Publishing to LinkedIn...")
    text = strip_leading_emojis(text)
    try:
        payload = {
            "author": LINKEDIN_AUTHOR_URN,
            "commentary": text,
            "visibility": "PUBLIC",
            "distribution": {
                "feedDistribution": "MAIN_FEED",
            },
            "lifecycleState": "PUBLISHED"
        }
        
        if len(media_items) > 0:
            image_items = [item for item in media_items if item["type"] == "IMAGE"]
            video_items = [item for item in media_items if item["type"] == "VIDEO"]
            media_urn = None

            if len(image_items) >= 2 and not video_items:
                image_items = image_items[:20]
                log(f"Uploading {len(image_items)} images to LinkedIn multiImage post...")
                image_urns = [upload_linkedin_image(item["local_path"]) for item in image_items]
                payload["content"] = {
                    "multiImage": {
                        "images": [
                            {"id": image_urn, "altText": "Post image"}
                            for image_urn in image_urns
                        ]
                    }
                }
            elif len(media_items) > 1:
                log("LinkedIn mixed/video multi-media is not supported yet; publishing the first media item only.")

            item = media_items[0]
            item_type = item["type"]
            local_path = item["local_path"]
            
            if payload.get("content", {}).get("multiImage"):
                pass
            elif item_type == "VIDEO":
                init_payload = {
                    "initializeUploadRequest": {
                        "owner": LINKEDIN_AUTHOR_URN,
                        "fileSizeBytes": local_path.stat().st_size,
                        "uploadCaptions": False,
                        "uploadThumbnail": False
                    }
                }
                res = call_linkedin("rest/videos?action=initializeUpload", init_payload)
                
                upload_token = res["value"]["uploadToken"]
                media_urn = res["value"]["video"]
                upload_instructions = res["value"]["uploadInstructions"]
                
                log(f"Uploading video in {len(upload_instructions)} chunks to LinkedIn...")
                uploaded_parts = []
                
                with open(local_path, "rb") as f:
                    for i, instruction in enumerate(upload_instructions):
                        upload_url = instruction["uploadUrl"]
                        first_byte = instruction["firstByte"]
                        last_byte = instruction["lastByte"]
                        
                        f.seek(first_byte)
                        chunk_size = last_byte - first_byte + 1
                        chunk_data = f.read(chunk_size)
                        
                        log(f"Uploading chunk {i+1}/{len(upload_instructions)} ({len(chunk_data)} bytes)...")
                        etag = upload_linkedin_chunk(upload_url, chunk_data)
                        uploaded_parts.append(etag)
                
                log("Finalizing video upload on LinkedIn...")
                finalize_payload = {
                    "finalizeUploadRequest": {
                        "video": media_urn,
                        "uploadToken": upload_token,
                        "uploadedPartIds": uploaded_parts
                    }
                }
                call_linkedin("rest/videos?action=finalizeUpload", finalize_payload)
                
                log("Waiting for video to become AVAILABLE on LinkedIn...")
                encoded_urn = urllib.parse.quote(media_urn)
                deadline = time.monotonic() + 300
                while True:
                    if time.monotonic() >= deadline:
                        raise Exception("Timed out waiting for LinkedIn video validation")
                    
                    status_res = call_linkedin(f"rest/videos/{encoded_urn}", payload=None, method="GET")
                    status = status_res.get("status")
                    log(f"LinkedIn video status: {status}")
                    if status == "AVAILABLE":
                        break
                    elif status == "PROCESSING_FAILED":
                        raise Exception("LinkedIn video processing failed")
                    time.sleep(10)
            else:
                media_urn = upload_linkedin_image(local_path)
                
            if "content" not in payload:
                payload["content"] = {
                    "media": {
                        "title": "Post Media",
                        "id": media_urn
                    }
                }
            
        res = call_linkedin("rest/posts", payload)
        log(f"LinkedIn post published successfully URN: {res.get('id', 'Unknown')}")
        return res.get("id")
        
    except Exception as exc:
        log(f"Error publishing to LinkedIn: {exc}")
        return None
