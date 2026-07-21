UPDATE `post_entity_links`
SET `link_role` = 'mention'
WHERE (`post_id`, `entity_id`) IN (
  SELECT p.post_id, e.id
  FROM post_entity_links l
  JOIN knowledge_entities e ON e.id = l.entity_id AND e.kind = 'model'
  JOIN posts p ON p.post_id = l.post_id
  JOIN post_locales r ON r.post_id = p.post_id AND r.locale = 'ru' AND r.site_enabled = 1
  WHERE l.link_role = 'focus'
    AND (
      lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%конкурент%'
      OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%сравнен%'
      OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '% против %'
      OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '% vs %'
      OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%competitor%'
      OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '%competes%'
      OR lower(substr(r.text, 1, instr(r.text || char(10), char(10)) - 1)) LIKE '% versus %'
    )
);
