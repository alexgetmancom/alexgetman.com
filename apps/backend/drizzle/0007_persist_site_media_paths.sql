-- The production archive's completed vertical-media cutover starts at post 108;
-- the listed older posts were individually materialized before that archive run.
UPDATE `post_locales`
SET `media_json` = (
  SELECT json_group_array(
    json(
      CASE
        WHEN coalesce(json_extract(item.value, '$.path'), '') <> '' THEN item.value
        WHEN lower(coalesce(json_extract(item.value, '$.type'), 'image')) = 'video' THEN
          json_set(
            item.value,
            '$.type', 'video',
            '$.path', 'media/posts/' || `post_locales`.`post_id` || '-' || `post_locales`.`locale` || '-' || item.key ||
              CASE
                WHEN `post_locales`.`post_id` >= 108 OR `post_locales`.`post_id` IN (88, 62, 49, 47, 19, 14, 13, 11, 10, 9)
                  THEN '-vertical.mp4'
                ELSE '.mp4'
              END,
            '$.poster', 'media/posts/' || `post_locales`.`post_id` || '-' || `post_locales`.`locale` || '-' || item.key || '-poster.jpg'
          )
        ELSE
          json_set(
            item.value,
            '$.type', 'image',
            '$.path', 'media/posts/' || `post_locales`.`post_id` || '-' || `post_locales`.`locale` || '-' || item.key ||
              CASE
                WHEN `post_locales`.`post_id` >= 108 OR `post_locales`.`post_id` IN (88, 62, 49, 47, 19, 14, 13, 11, 10, 9)
                  THEN '-vertical.jpg'
                ELSE '.jpg'
              END
          )
      END
    )
  )
  FROM json_each(`post_locales`.`media_json`) AS item
)
WHERE `site_enabled` = 1
  AND json_valid(`media_json`)
  AND json_array_length(`media_json`) > 0
  AND EXISTS (
    SELECT 1
    FROM json_each(`post_locales`.`media_json`) AS missing
    WHERE coalesce(json_extract(missing.value, '$.path'), '') = ''
  );
