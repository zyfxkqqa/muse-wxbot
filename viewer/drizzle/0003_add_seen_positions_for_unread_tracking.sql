CREATE TABLE seen_positions (
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seen_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bot_id, conversation_id)
);
