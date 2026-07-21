ALTER TABLE `post_entity_links` ADD `link_role` text NOT NULL DEFAULT 'mention';
--> statement-breakpoint
DELETE FROM `knowledge_entity_aliases`
WHERE `entity_id` IN (SELECT `id` FROM `knowledge_entities` WHERE `kind` = 'product' AND `slug` IN ('claude', 'codex'));
--> statement-breakpoint
DELETE FROM `post_entity_links`
WHERE `entity_id` IN (SELECT `id` FROM `knowledge_entities` WHERE `kind` = 'product' AND `slug` IN ('claude', 'codex'));
--> statement-breakpoint
DELETE FROM `knowledge_entities` WHERE `kind` = 'product' AND `slug` IN ('claude', 'codex');
--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_entities` (`kind`, `slug`, `title_ru`, `title_en`, `created_at`, `updated_at`)
VALUES ('topic', 'codex', 'Codex', 'Codex', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--> statement-breakpoint
INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `link_role`, `created_at`)
SELECT p.post_id, e.id, 'focus', CURRENT_TIMESTAMP
FROM publications pub
JOIN posts p ON p.post_id = pub.post_id
JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1
JOIN knowledge_entities e ON e.kind = 'topic' AND e.slug = 'codex'
WHERE pub.status IN ('published', 'failed')
  AND (
    lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%codex%'
    OR lower(substr(r.text, 1, 420)) LIKE '%с помощью%codex%'
    OR lower(substr(r.text, 1, 420)) LIKE '%built%with codex%'
    OR lower(substr(r.text, 1, 420)) LIKE '%created%with codex%'
    OR lower(substr(r.text, 1, 420)) LIKE '%made%with codex%'
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `link_role`, `created_at`)
SELECT p.post_id, e.id, 'focus', CURRENT_TIMESTAMP
FROM publications pub
JOIN posts p ON p.post_id = pub.post_id
JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1
JOIN knowledge_entities e ON e.kind = 'model'
WHERE pub.status IN ('published', 'failed')
  AND (
    (e.slug = 'claude' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%claude%') OR
    (e.slug = 'fable-5' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%fable%') OR
    (e.slug = 'gpt-5-6-sol' AND (lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%gpt-5.6 sol%' OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%gpt 5.6 sol%')) OR
    (e.slug = 'gemini-3-6-flash' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%gemini 3.6 flash%') OR
    (e.slug = 'kimi-k3' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%kimi k3%')
  );
--> statement-breakpoint
UPDATE `post_entity_links`
SET `link_role` = 'focus'
WHERE (`post_id`, `entity_id`) IN (
  SELECT p.post_id, e.id
  FROM publications pub
  JOIN posts p ON p.post_id = pub.post_id
  JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1
  JOIN knowledge_entities e ON e.kind = 'model'
  WHERE pub.status IN ('published', 'failed')
    AND (
      (e.slug = 'claude' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%claude%') OR
      (e.slug = 'fable-5' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%fable%') OR
      (e.slug = 'gpt-5-6-sol' AND (lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%gpt-5.6 sol%' OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%gpt 5.6 sol%')) OR
      (e.slug = 'gemini-3-6-flash' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%gemini 3.6 flash%') OR
      (e.slug = 'kimi-k3' AND lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%kimi k3%')
    )
);
