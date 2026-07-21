INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `created_at`)
SELECT p.post_id, e.id, CURRENT_TIMESTAMP
FROM publications pub
JOIN posts p ON p.post_id = pub.post_id
JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1
JOIN knowledge_entities e ON e.kind = 'model'
WHERE pub.status IN ('published', 'failed')
  AND (
    (e.slug = 'claude' AND lower(substr(r.text, 1, 350)) LIKE '%claude%') OR
    (e.slug = 'fable-5' AND lower(substr(r.text, 1, 350)) LIKE '%fable%') OR
    (e.slug = 'gpt-5-6-sol' AND (lower(substr(r.text, 1, 350)) LIKE '%gpt-5.6 sol%' OR lower(substr(r.text, 1, 350)) LIKE '%gpt 5.6 sol%')) OR
    (e.slug = 'gemini-3-6-flash' AND lower(substr(r.text, 1, 350)) LIKE '%gemini 3.6 flash%') OR
    (e.slug = 'kimi-k3' AND lower(substr(r.text, 1, 350)) LIKE '%kimi k3%')
  );
--> statement-breakpoint
INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `created_at`)
SELECT l.post_id, child.parent_entity_id, CURRENT_TIMESTAMP
FROM post_entity_links l
JOIN knowledge_entities child ON child.id = l.entity_id
WHERE child.parent_entity_id IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `created_at`)
SELECT p.post_id, e.id, CURRENT_TIMESTAMP
FROM publications pub
JOIN posts p ON p.post_id = pub.post_id
JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1
JOIN knowledge_entities e ON e.kind = 'company'
WHERE pub.status IN ('published', 'failed')
  AND ((e.slug = 'openai' AND lower(substr(r.text, 1, 350)) LIKE '%openai%') OR (e.slug = 'google' AND lower(substr(r.text, 1, 350)) LIKE '%google%') OR (e.slug = 'moonshot-ai' AND lower(substr(r.text, 1, 350)) LIKE '%moonshot%'));
