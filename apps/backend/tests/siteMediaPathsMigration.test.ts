import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

it("persists deterministic public paths for legacy site media", () => {
  const db = new Database(":memory:", { strict: true });
  try {
    db.exec(`
      CREATE TABLE post_locales (
        post_id integer NOT NULL,
        locale text NOT NULL,
        media_json text,
        site_enabled integer NOT NULL DEFAULT 0,
        PRIMARY KEY (post_id, locale)
      );
      INSERT INTO post_locales VALUES
        (7, 'ru', '[{"type":"image","file_id":"source"}]', 1),
        (7, 'en', '[{"type":"video","file_id":"source"}]', 1),
        (8, 'en', '[{"type":"image","path":"media/posts/custom.jpg"}]', 1),
        (9, 'en', '[{"type":"image","file_id":"private"}]', 0),
        (108, 'en', '[{"type":"image","file_id":"source"}]', 1);
    `);

    db.exec(readFileSync(path.join(import.meta.dir, "../drizzle/0007_persist_site_media_paths.sql"), "utf8"));

    const rows = db.query("SELECT post_id, locale, media_json FROM post_locales ORDER BY post_id, locale").all() as Array<{
      post_id: number;
      locale: string;
      media_json: string;
    }>;
    expect(rows.map((row) => ({ ...row, media_json: JSON.parse(row.media_json) }))).toEqual([
      {
        post_id: 7,
        locale: "en",
        media_json: [
          {
            type: "video",
            file_id: "source",
            path: "media/posts/7-en-0.mp4",
            poster: "media/posts/7-en-0-poster.jpg",
          },
        ],
      },
      {
        post_id: 7,
        locale: "ru",
        media_json: [{ type: "image", file_id: "source", path: "media/posts/7-ru-0.jpg" }],
      },
      { post_id: 8, locale: "en", media_json: [{ type: "image", path: "media/posts/custom.jpg" }] },
      { post_id: 9, locale: "en", media_json: [{ type: "image", file_id: "private" }] },
      { post_id: 108, locale: "en", media_json: [{ type: "image", file_id: "source", path: "media/posts/108-en-0-vertical.jpg" }] },
    ]);
  } finally {
    db.close();
  }
});
