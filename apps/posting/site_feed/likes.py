from __future__ import annotations

import sqlite3

from site_feed.config import DATA_DIR, LIKES_DB, LIKES_LOCK

def init_likes_db():
    with LIKES_LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(LIKES_DB))
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS likes (
                    post_id TEXT,
                    ip_hash TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (post_id, ip_hash)
                )
            """)
            conn.commit()
        finally:
            conn.close()


def get_likes_info(post_id, ip_hash):
    with LIKES_LOCK:
        conn = sqlite3.connect(str(LIKES_DB))
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM likes WHERE post_id = ?", (post_id,))
            count = cursor.fetchone()[0]
            cursor.execute("SELECT 1 FROM likes WHERE post_id = ? AND ip_hash = ?", (post_id, ip_hash))
            user_liked = cursor.fetchone() is not None
            return {"likes": count, "user_liked": user_liked}
        finally:
            conn.close()


def toggle_like(post_id, ip_hash):
    with LIKES_LOCK:
        conn = sqlite3.connect(str(LIKES_DB))
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT 1 FROM likes WHERE post_id = ? AND ip_hash = ?", (post_id, ip_hash))
            exists = cursor.fetchone() is not None
            if exists:
                cursor.execute("DELETE FROM likes WHERE post_id = ? AND ip_hash = ?", (post_id, ip_hash))
            else:
                cursor.execute("INSERT INTO likes (post_id, ip_hash) VALUES (?, ?)", (post_id, ip_hash))
            conn.commit()
            
            cursor.execute("SELECT COUNT(*) FROM likes WHERE post_id = ?", (post_id,))
            count = cursor.fetchone()[0]
            return {"likes": count, "user_liked": not exists}
        finally:
            conn.close()


def get_batch_likes(post_ids, ip_hash):
    res = {}
    if not post_ids:
        return res
    for pid in post_ids:
        res[pid] = {"likes": 0, "user_liked": False}
        
    with LIKES_LOCK:
        conn = sqlite3.connect(str(LIKES_DB))
        try:
            cursor = conn.cursor()
            placeholders = ",".join("?" for _ in post_ids)
            cursor.execute(
                f"SELECT post_id, COUNT(*) FROM likes WHERE post_id IN ({placeholders}) GROUP BY post_id",
                post_ids
            )
            for row in cursor.fetchall():
                pid, count = row
                res[pid]["likes"] = count
                
            cursor.execute(
                f"SELECT post_id FROM likes WHERE ip_hash = ? AND post_id IN ({placeholders})",
                [ip_hash] + post_ids
            )
            for row in cursor.fetchall():
                pid = row[0]
                res[pid]["user_liked"] = True
                
            return res
        finally:
            conn.close()
