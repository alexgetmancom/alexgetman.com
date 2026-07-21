ALTER TABLE `knowledge_entities` ADD `parent_entity_id` integer;
--> statement-breakpoint
CREATE INDEX `idx_knowledge_entities_parent` ON `knowledge_entities` (`parent_entity_id`);
--> statement-breakpoint
DELETE FROM `post_entity_links`
WHERE `entity_id` IN (SELECT `id` FROM `knowledge_entities` WHERE `kind` = 'model' AND `slug` = 'codex');
--> statement-breakpoint
DELETE FROM `knowledge_entities` WHERE `kind` = 'model' AND `slug` = 'codex';
--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_entities` (`kind`, `slug`, `title_ru`, `title_en`, `created_at`, `updated_at`)
VALUES
  ('company', 'anthropic', 'Anthropic', 'Anthropic', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('company', 'openai', 'OpenAI', 'OpenAI', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('company', 'google', 'Google', 'Google', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('company', 'moonshot-ai', 'Moonshot AI', 'Moonshot AI', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_entities` (`kind`, `slug`, `title_ru`, `title_en`, `parent_entity_id`, `created_at`, `updated_at`)
VALUES
  ('model', 'claude', 'Claude', 'Claude', (SELECT id FROM knowledge_entities WHERE kind = 'company' AND slug = 'anthropic'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('model', 'fable-5', 'Fable 5', 'Fable 5', (SELECT id FROM knowledge_entities WHERE kind = 'company' AND slug = 'anthropic'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('model', 'gpt-5-6-sol', 'GPT-5.6 Sol', 'GPT-5.6 Sol', (SELECT id FROM knowledge_entities WHERE kind = 'company' AND slug = 'openai'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('model', 'gemini-3-6-flash', 'Gemini 3.6 Flash', 'Gemini 3.6 Flash', (SELECT id FROM knowledge_entities WHERE kind = 'company' AND slug = 'google'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('model', 'kimi-k3', 'Kimi K3', 'Kimi K3', (SELECT id FROM knowledge_entities WHERE kind = 'company' AND slug = 'moonshot-ai'), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
--> statement-breakpoint
UPDATE `knowledge_entities`
SET `title_ru` = 'Claude', `title_en` = 'Claude', `parent_entity_id` = (SELECT id FROM knowledge_entities WHERE kind = 'company' AND slug = 'anthropic')
WHERE `kind` = 'model' AND `slug` = 'claude';
--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_entity_aliases` (`entity_id`, `alias`, `normalized_alias`, `created_at`)
SELECT id, title_en, lower(title_en), CURRENT_TIMESTAMP FROM knowledge_entities WHERE kind IN ('company', 'model');
--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_entity_aliases` (`entity_id`, `alias`, `normalized_alias`, `created_at`)
SELECT id, 'Fable', 'fable', CURRENT_TIMESTAMP FROM knowledge_entities WHERE kind = 'model' AND slug = 'fable-5';
--> statement-breakpoint
INSERT OR IGNORE INTO `knowledge_entity_aliases` (`entity_id`, `alias`, `normalized_alias`, `created_at`)
SELECT id, 'GPT 5.6 Sol', 'gpt 5.6 sol', CURRENT_TIMESTAMP FROM knowledge_entities WHERE kind = 'model' AND slug = 'gpt-5-6-sol';
