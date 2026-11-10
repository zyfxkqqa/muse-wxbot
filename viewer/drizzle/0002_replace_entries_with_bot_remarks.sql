DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE bot_remarks (
  bot_id TEXT PRIMARY KEY,
  remark TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
