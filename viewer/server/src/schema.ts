// Drizzle schema for this space.
//
// The viewer reads WeChat bot bindings and chat history live from the bot's
// own files on every poll (see privileged.ts) — nothing of that is copied
// here. Artifact-owned data:
//   - bot_remarks:   the user's remark （备注） for each bound bot, keyed by
//                    binding id.
//   - seen_positions: how many messages of each conversation the user has
//                    seen in this viewer, so unread counts survive reopening
//                    the page. Keyed by binding id + conversation id. Only
//                    the count is stored, never message content.

import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const botRemarks = sqliteTable("bot_remarks", {
  botId: text("bot_id").primaryKey(),
  remark: text("remark").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const seenPositions = sqliteTable(
  "seen_positions",
  {
    botId: text("bot_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    seenCount: integer("seen_count").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [primaryKey({ columns: [table.botId, table.conversationId] })],
);
