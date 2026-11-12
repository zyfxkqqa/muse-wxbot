import { randomUUID } from "node:crypto";
import { WechatClawbotApi } from "./wechat-clawbot-api.js";
import {
  WechatBotBinding,
  WechatBotStore,
  WechatMessage,
  WechatMessageHandler,
  WechatProvisionStatus
} from "./types.js";

export class WechatClawbotProvisioner {
  constructor(
    private readonly deps: {
      api: WechatClawbotApi;
      store: WechatBotStore;
    }
  ) {}

  async createBot(options: {
    timeoutMs?: number;
    onStatus?: (status: WechatProvisionStatus) => void | Promise<void>;
  } = {}) {
    const timeoutMs = options.timeoutMs ?? 8 * 60 * 1000;
    await options.onStatus?.({ phase: "WECHAT_GENERATING_QR" });
    const login = await this.deps.api.startLogin();
    await options.onStatus?.({
      phase: "WECHAT_WAITING_FOR_SCAN",
      qrImageDataUrl: login.qrcode_img_content,
      qrValue: login.qrcode
    });

    let currentBaseUrl = this.deps.api.defaultBaseUrl();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // P9 (L15): --timeout-ms is only approximate if a single 75s status
      // query can overshoot it — cap each query by the time remaining.
      const remainingMs = deadline - Date.now();
      const status = await this.pollWechatLoginStatus(currentBaseUrl, login.qrcode, options.onStatus, Math.min(75_000, remainingMs));
      if (!status) {
        await this.sleep(1200);
        continue;
      }
      if (status.status === "scaned") {
        await options.onStatus?.({ phase: "WECHAT_SCANNED", message: "已扫码，请在微信中确认授权。" });
      } else if (status.status === "scaned_but_redirect" && status.redirect_host) {
        currentBaseUrl = `https://${status.redirect_host}`;
      } else if (status.status === "need_verifycode") {
        throw new Error("微信 ClawBot 要求输入手机验证码，当前存根未实现验证码步骤，请重新发起绑定。");
      } else if (status.status === "verify_code_blocked") {
        throw new Error("微信 ClawBot 验证码多次错误，本次绑定已停止，请稍后重试。");
      } else if (status.status === "expired") {
        throw new Error("微信 ClawBot 二维码已过期，请重新发起绑定。");
      } else if (status.status === "binded_redirect") {
        throw new Error("该微信 ClawBot 已连接过其他 OpenClaw/网关，请先在微信侧解除后再绑定。");
      } else if (status.status === "confirmed") {
        const binding = await this.finishBinding(currentBaseUrl, status);
        // M10: establish the getUpdates cursor right after binding, with
        // one ~25s long-poll (the same manual step that had to be done by
        // hand on 2026-11-10, now built in) — so a newly bound bot does not
        // depend on the hook's first 6s poll to create its cursor. Best
        // effort: if the long-poll times out with no messages (the normal
        // idle case) or errors, the binding still stands and the hook's
        // first poll establishes the cursor as before.
        try {
          const res = await this.deps.api.getUpdates({
            baseUrl: currentBaseUrl,
            token: binding.token,
            getUpdatesBuf: "",
            timeoutMs: 25_000
          });
          if (res.get_updates_buf) {
            binding.metadata = { ...(binding.metadata ?? {}), getUpdatesBuf: res.get_updates_buf };
            await this.deps.store.save(binding);
          }
        } catch {
          /* ignore — cursor will be established by the hook's first poll */
        }
        await options.onStatus?.({ phase: "WECHAT_CONFIRMED", message: "微信机器人开通成功。" });
        return binding;
      }
      await this.sleep(1200);
    }
    throw new Error("微信 ClawBot 扫码超时，请重新发起绑定。");
  }

  /**
   * @deprecated Legacy polling path — nothing calls it. The only polling
   * path in production is the hook (`wechat-inbox.sh`) driving
   * `wechat-bot poll` / `poll-all` (CLI pollBot). Do not wire this up.
   */
  startPolling(
    bot: WechatBotBinding,
    handler: WechatMessageHandler,
    options: { timeoutMs?: number; intervalAfterErrorMs?: number } = {}
  ) {
    const abort = new AbortController();
    void this.pollLoop(bot, handler, abort, options);
    return { stop: () => abort.abort() };
  }

  /**
   * @deprecated See startPolling — legacy only, not used by the CLI or hook.
   */
  async startPollingAll(handler: WechatMessageHandler, options: { timeoutMs?: number; intervalAfterErrorMs?: number } = {}) {
    const bots = await this.deps.store.listActive();
    return bots.map((bot) => this.startPolling(bot, handler, options));
  }

  private async finishBinding(baseUrl: string, status: { bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string }) {
    const platformBotId = status.ilink_bot_id?.trim();
    const token = status.bot_token?.trim();
    const ownerExternalId = status.ilink_user_id?.trim();
    if (!platformBotId || !token || !ownerExternalId) {
      throw new Error("微信 ClawBot 扫码成功，但官方接口未返回完整机器人凭证。");
    }
    const now = new Date().toISOString();
    return this.deps.store.save({
      id: randomUUID(),
      platform: "WECHAT",
      platformBotId,
      token,
      baseUrl,
      ownerExternalId,
      displayName: "微信 ClawBot",
      createdAt: now,
      updatedAt: now,
      metadata: { source: "official_clawbot_ilink" }
    });
  }

  private async pollWechatLoginStatus(
    currentBaseUrl: string,
    qrcode: string,
    onStatus?: (status: WechatProvisionStatus) => void | Promise<void>,
    timeoutMs = 75_000
  ) {
    try {
      return await this.deps.api.pollLoginStatus(currentBaseUrl, qrcode, undefined, timeoutMs);
    } catch (error) {
      if (!this.isAbortError(error)) throw error;
      await onStatus?.({
        phase: "WECHAT_WAITING_FOR_SCAN",
        message: "微信官方接口本次轮询超时，继续等待扫码确认。",
        lastPollTimeoutAt: new Date().toISOString()
      });
      return null;
    }
  }

  private async pollLoop(
    bot: WechatBotBinding,
    handler: WechatMessageHandler,
    abort: AbortController,
    options: { timeoutMs?: number; intervalAfterErrorMs?: number }
  ) {
    let getUpdatesBuf: string | undefined;
    while (!abort.signal.aborted) {
      try {
        const response = await this.deps.api.getUpdates({
          baseUrl: bot.baseUrl,
          token: bot.token,
          getUpdatesBuf,
          timeoutMs: options.timeoutMs ?? 35_000,
          abortSignal: abort.signal
        });
        if (response.get_updates_buf) getUpdatesBuf = response.get_updates_buf;
        if (response.ret !== undefined && response.ret !== 0) {
          throw new Error(`微信 ClawBot 拉取消息失败：ret=${response.ret} ${response.errmsg ?? ""}`);
        }
        if (response.errcode !== undefined && response.errcode !== 0) {
          throw new Error(`微信 ClawBot 拉取消息失败：errcode=${response.errcode} ${response.errmsg ?? ""}`);
        }
        for (const message of response.msgs ?? []) {
          await this.handleMessage(bot, message, handler);
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        await this.deps.store.markError?.(bot.id, message);
        await this.sleep(options.intervalAfterErrorMs ?? 3000);
      }
    }
  }

  /**
   * @deprecated Legacy only — text-only, does NOT support media: a message
   * with no text (image/voice/video/file) is silently dropped here. The
   * production polling path is the CLI's pollBot, which handles media.
   * Kept only because pollLoop references it; do not call directly.
   */
  private async handleMessage(bot: WechatBotBinding, raw: WechatMessage, handler: WechatMessageHandler) {
    if (raw.message_type === 2) return;
    const fromUserId = raw.from_user_id?.trim();
    const text = raw.item_list?.map((item) => item.text_item?.text ?? "").join("").trim();
    if (!fromUserId || !text) return;
    const messageId = String(raw.message_id ?? raw.client_id ?? `${bot.id}:${raw.seq ?? Date.now()}`);
    const result = await handler(
      {
        botId: bot.id,
        fromUserId,
        conversationId: raw.session_id || fromUserId,
        messageId,
        messageType: String(raw.message_type ?? "text"),
        text,
        raw
      },
      bot
    );
    const reply = typeof result === "string" ? result : result?.reply ?? "";
    if (reply) {
      await this.deps.api.sendText({
        baseUrl: bot.baseUrl,
        token: bot.token,
        toUserId: fromUserId,
        contextToken: raw.context_token,
        text: reply
      });
    }
  }

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isAbortError(error: unknown) {
    if (!(error instanceof Error)) return false;
    return error.name === "AbortError" || /operation was aborted|aborted/i.test(error.message);
  }
}
