-- Threads posts are held to 500 characters so they fit a single post. This
-- column records the one case the rule cannot cover: the author looked at how
-- many posts the chain would take and chose it anyway, for this draft only.
-- Default 0 means every existing and future draft starts under the rule.
ALTER TABLE `drafts` ADD `threads_chain_approved` integer DEFAULT 0 NOT NULL;
