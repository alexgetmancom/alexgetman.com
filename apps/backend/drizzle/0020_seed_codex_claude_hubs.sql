INSERT OR IGNORE INTO `knowledge_entities` (`kind`, `slug`, `title_ru`, `title_en`, `summary_ru`, `summary_en`, `created_at`, `updated_at`)
VALUES
  ('product', 'codex', 'Codex', 'Codex', 'Инструмент OpenAI для агентской разработки и работы с кодом.', 'OpenAI tool for agentic software development and coding.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('product', 'claude', 'Claude', 'Claude', 'Линейка моделей и продуктов Anthropic.', 'Anthropic model and product family.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--> statement-breakpoint
INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `created_at`)
SELECT p.post_id, e.id, CURRENT_TIMESTAMP FROM posts p JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1 JOIN knowledge_entities e ON e.kind = 'product' AND e.slug = 'codex' WHERE lower(r.text) LIKE '%codex%';
--> statement-breakpoint
INSERT OR IGNORE INTO `post_entity_links` (`post_id`, `entity_id`, `created_at`)
SELECT p.post_id, e.id, CURRENT_TIMESTAMP FROM posts p JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1 JOIN knowledge_entities e ON e.kind = 'product' AND e.slug = 'claude' WHERE lower(r.text) LIKE '%claude%' OR lower(r.text) LIKE '%fable%';
