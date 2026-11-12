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
  conversationSha: z.string(),
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
      media: z
        .array(z.object({ kind: z.string(), localPath: z.string() }))
        .optional(),
    }),
  ),
});

const mediaResponse = z.object({
  found: z.boolean(),
  dataBase64: z.string(),
  mimeType: z.string(),
  size: z.number(),
  filename: z.string(),
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
        seenRows.map((r) => [`${r.botId}|${r.conversationId}`, r]),
      );
      // A stored seen count can exceed the live message count when the row
      // was written against an older, longer history file (e.g. before the
      // 2026-11-12 migration to ~/workspace/wechat-bots/). Clamping with
      // Math.min() then marks everything as read and the unread badges
      // never appear. Resolve such stale rows by their write time instead:
      // messages timestamped at or before updatedAt count as seen.
      const resolvedSeen = new Map<string, number>();
      await Promise.all(
        live.bots.flatMap((bot) =>
          bot.conversations.map(async (c) => {
            const key = `${bot.id}|${c.id}`;
            const row = seenByKey.get(key);
            if (!row) {
              resolvedSeen.set(key, 0);
            } else if (row.seenCount <= c.messageCount) {
              resolvedSeen.set(key, row.seenCount);
            } else {
              const liveConv = await ctx.executePrivileged(
                WechatPrivileged.getConversationMessages,
                { botId: bot.id, conversationId: c.id },
              );
              const anchorMs = row.updatedAt.getTime();
              resolvedSeen.set(
                key,
                (liveConv.messages ?? []).filter(
                  (m) => new Date(m.ts).getTime() <= anchorMs,
                ).length,
              );
            }
          }),
        ),
      );
      return {
        bots: live.bots.map((bot) => {
          // ownerExternalId is only needed host-side (it keys the history
          // folder); the client never uses it, so it stays out of the
          // response.
          const { ownerExternalId: _ownerExternalId, ...botFields } = bot;
          const conversations = bot.conversations.map((c) => {
            const seen = resolvedSeen.get(`${bot.id}|${c.id}`) ?? 0;
            return { ...c, unreadCount: c.messageCount - seen };
          });
          return {
            ...botFields,
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

  getMedia: defineAction({
    description:
      "Returns one media attachment (image/video/file) of a chat message as base64, read from the bot's media folder only.",
    request: z.object({
      localPath: z.string().min(1),
    }),
    response: mediaResponse,
    privileged: [WechatPrivileged.getMediaFile],
    async handler(ctx, args): Promise<z.infer<typeof mediaResponse>> {
      return ctx.executePrivileged(WechatPrivileged.getMediaFile, {
        localPath: args.localPath,
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

  sendMessage: defineAction({
    description:
      "Sends one text message as the bot to the friend of the open conversation, and records it in the conversation history. The bot and target are resolved server-side from the bindings; the client passes only the bot prefix and conversation sha.",
    request: z.object({
      botId8: z.string().min(1),
      conversationSha: z.string().min(1),
      text: z.string().min(1),
    }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable() }),
    privileged: [WechatPrivileged.sendMessage],
    async handler(ctx, args): Promise<{ ok: boolean; error: string | null }> {
      const res = await ctx.executePrivileged(WechatPrivileged.sendMessage, {
        botId8: args.botId8,
        conversationSha: args.conversationSha,
        text: args.text,
      });
      ctx.invalidateQueries();
      return res;
    },
  }),

  sendMedia: defineAction({
    description:
      "Sends one image/video/voice/file as the bot to the friend of the open conversation (optional caption text is sent first as its own text message), and records it in the conversation history. Images over 250KB are auto-compressed server-side before sending; the response reports whether compression ran and the before/after byte sizes. The file is uploaded as base64; the bot and target are resolved server-side from the bindings; the client passes only the bot prefix, conversation sha, filename, and bytes.",
    request: z.object({
      botId8: z.string().min(1),
      conversationSha: z.string().min(1),
      filename: z.string().min(1).max(255),
      dataBase64: z.string().min(1),
      mimeType: z.string().max(120),
      caption: z.string().max(2000),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      compressed: z.boolean(),
      originalBytes: z.number(),
      finalBytes: z.number(),
    }),
    privileged: [WechatPrivileged.sendMedia],
    async handler(
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      error: string | null;
      compressed: boolean;
      originalBytes: number;
      finalBytes: number;
    }> {
      const res = await ctx.executePrivileged(WechatPrivileged.sendMedia, {
        botId8: args.botId8,
        conversationSha: args.conversationSha,
        filename: args.filename,
        dataBase64: args.dataBase64,
        mimeType: args.mimeType,
        caption: args.caption,
      });
      ctx.invalidateQueries();
      return res;
    },
  }),

  setPaused: defineAction({
    description:
      "Pauses or resumes the bot's automatic replies for one conversation. Paused means the worker records the friend's incoming messages but sends no reply; the user replies manually from the viewer.",
    request: z.object({
      botId8: z.string().min(1),
      conversationSha: z.string().min(1),
      paused: z.boolean(),
    }),
    response: z.object({ paused: z.boolean(), error: z.string().nullable() }),
    privileged: [WechatPrivileged.setPaused],
    async handler(
      ctx,
      args,
    ): Promise<{ paused: boolean; error: string | null }> {
      const res = await ctx.executePrivileged(WechatPrivileged.setPaused, {
        botId8: args.botId8,
        conversationSha: args.conversationSha,
        paused: args.paused,
      });
      ctx.invalidateQueries();
      return res;
    },
  }),

  getPaused: defineAction({
    description:
      "Reports whether automatic replies are currently paused for one conversation.",
    request: z.object({
      botId8: z.string().min(1),
      conversationSha: z.string().min(1),
    }),
    response: z.object({ paused: z.boolean(), error: z.string().nullable() }),
    privileged: [WechatPrivileged.getPaused],
    async handler(
      ctx,
      args,
    ): Promise<{ paused: boolean; error: string | null }> {
      return ctx.executePrivileged(WechatPrivileged.getPaused, {
        botId8: args.botId8,
        conversationSha: args.conversationSha,
      });
    },
  }),
} satisfies ActionsModule;
