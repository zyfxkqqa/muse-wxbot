// Actions for the WeChat bot conversation viewer.
//
// Bindings and chat history are read live from the bot's own files through
// privileged host functions (see privileged.ts) — nothing is copied into the
// artifact DB, so every poll sees the newest messages at zero token cost.
// Stored here: the user's per-bot remark （备注） and, per conversation, how
// many messages the user has seen in this viewer (drives the unread badges
// and where an opened conversation starts).

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { and, eq } from "drizzle-orm";
import { WechatPrivileged } from "@space/privileged";
import * as schema from "./schema";

const conversationShape = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
  status: z.string(),
  messageCount: z.number(),
  unreadCount: z.number(),
});

const botShape = z.object({
  id: z.string(),
  label: z.string(),
  displayName: z.string(),
  platformBotId: z.string(),
  ownerExternalId: z.string(),
  createdAt: z.string(),
  lastError: z.string().nullable(),
  remark: z.string(),
  unreadTotal: z.number(),
  conversations: z.array(conversationShape),
});

const overviewResponse = z.object({
  bots: z.array(botShape),
  bindingsFound: z.boolean(),
  fetchedAt: z.string(),
});

const messagesResponse = z.object({
  found: z.boolean(),
  messages: z.array(
    z.object({
      ts: z.string(),
      role: z.string(),
      text: z.string(),
    }),
  ),
});

export const Actions = {
  getOverview: defineAction({
    description:
      "Lists the bound WeChat bots with their conversations and the user's saved remarks, read live from the bot's state files.",
    request: z.object({}),
    response: overviewResponse,
    privileged: [
      WechatPrivileged.listBotsAndConversations,
      WechatPrivileged.getConversationMessages,
    ],
    async handler(ctx): Promise<z.infer<typeof overviewResponse>> {
      const live = await ctx.executePrivileged(
        WechatPrivileged.listBotsAndConversations,
        {},
      );
      const db = ctx.db<typeof schema>();
      const remarkRows = await db.select().from(schema.botRemarks);
      const remarkByBot = new Map(remarkRows.map((r) => [r.botId, r.remark]));
      const seenRows = await db.select().from(schema.seenPositions);
      const seenByKey = new Map(
        seenRows.map((r) => [`${r.botId}|${r.conversationId}`, r.seenCount]),
      );
      return {
        bots: live.bots.map((bot) => {
          const conversations = bot.conversations.map((c) => {
            const seen = Math.min(
              seenByKey.get(`${bot.id}|${c.id}`) ?? 0,
              c.messageCount,
            );
            return { ...c, unreadCount: c.messageCount - seen };
          });
          return {
            ...bot,
            remark: remarkByBot.get(bot.id) ?? "",
            conversations,
            unreadTotal: conversations.reduce(
              (sum, c) => sum + c.unreadCount,
              0,
            ),
          };
        }),
        bindingsFound: live.bindingsFound,
        fetchedAt: new Date().toISOString(),
      };
    },
  }),

  getMessages: defineAction({
    description:
      "Returns every message of one conversation of one bound WeChat bot, in chronological order, read live from its history file.",
    request: z.object({
      botId: z.string().min(1),
      conversationId: z.string().min(1),
    }),
    response: messagesResponse,
    privileged: [WechatPrivileged.getConversationMessages],
    async handler(ctx, args): Promise<z.infer<typeof messagesResponse>> {
      return ctx.executePrivileged(WechatPrivileged.getConversationMessages, {
        botId: args.botId,
        conversationId: args.conversationId,
      });
    },
  }),

  markConversationSeen: defineAction({
    description:
      "Records that the user has seen the first N messages of one conversation, so unread badges shrink and reopening starts at the next new message.",
    request: z.object({
      botId: z.string().min(1),
      conversationId: z.string().min(1),
      seenCount: z.number().int().min(0),
    }),
    response: z.object({ ok: z.literal(true) }),
    privileged: [WechatPrivileged.getConversationMessages],
    async handler(ctx, args): Promise<{ ok: true }> {
      // Clamp to the real message count so a stale client can never mark
      // messages as seen that do not exist yet.
      const live = await ctx.executePrivileged(
        WechatPrivileged.getConversationMessages,
        { botId: args.botId, conversationId: args.conversationId },
      );
      const seenCount = Math.min(args.seenCount, live.messages.length);
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select()
        .from(schema.seenPositions)
        .where(
          and(
            eq(schema.seenPositions.botId, args.botId),
            eq(schema.seenPositions.conversationId, args.conversationId),
          ),
        );
      const current = existing[0]?.seenCount ?? 0;
      if (seenCount > current) {
        await db
          .insert(schema.seenPositions)
          .values({
            botId: args.botId,
            conversationId: args.conversationId,
            seenCount,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              schema.seenPositions.botId,
              schema.seenPositions.conversationId,
            ],
            set: { seenCount, updatedAt: new Date() },
          });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),

  setRemark: defineAction({
    description:
      "Saves (or clears, when empty) the user's remark for one bound WeChat bot.",
    request: z.object({
      botId: z.string().min(1),
      remark: z.string().max(60),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const remark = args.remark.trim();
      if (!remark) {
        await db
          .delete(schema.botRemarks)
          .where(eq(schema.botRemarks.botId, args.botId));
      } else {
        await db
          .insert(schema.botRemarks)
          .values({ botId: args.botId, remark, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: schema.botRemarks.botId,
            set: { remark, updatedAt: new Date() },
          });
      }
      ctx.invalidateQueries();
      return { ok: true as const };
    },
  }),
} satisfies ActionsModule;
