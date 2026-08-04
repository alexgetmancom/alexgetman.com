UPDATE `conversation_sessions`
SET
	`control_message_id` = CAST(json_extract(`data_json`, '$.controlMessageId') AS INTEGER),
	`data_json` = json_remove(`data_json`, '$.controlMessageId')
WHERE `kind` = 'video'
	AND `control_message_id` IS NULL
	AND json_type(`data_json`, '$.controlMessageId') IN ('integer', 'real');
