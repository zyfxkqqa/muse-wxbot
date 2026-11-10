import { randomBytes } from "node:crypto";
import {
  WechatGetUpdatesResponse,
  WechatQrResponse,
  WechatQrStatusResponse
} from "./types.js";

export class WechatClawbotApi {
  private static readonly fixedBaseUrl = "https://ilinkai.weixin.qq.com";
  private static readonly botType = "3";
  private static readonly appId = "bot";
  private static readonly appClientVersion = String((2 << 16) | (4 << 8) | 4);
  private static readonly botAgent = "ReusableWechatBot/0.1.0 OpenClaw/2.4.4";

  async startLogin() {
    const raw = await this.post({
      baseUrl: WechatClawbotApi.fixedBaseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WechatClawbotApi.botType)}`,
      body: { local_token_list: [] },
      label: "微信 ClawBot 二维码生成"
    });
    const parsed = JSON.parse(raw) as WechatQrResponse;
    if (!parsed.qrcode || !parsed.qrcode_img_content) {
      throw new Error("微信 ClawBot 未返回可用二维码");
    }
    return parsed;
  }

  async pollLoginStatus(baseUrl: string, qrcode: string, verifyCode?: string) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const raw = await this.get({ baseUrl, endpoint, label: "微信 ClawBot 扫码状态", timeoutMs: 75_000 });
    return JSON.parse(raw) as WechatQrStatusResponse;
  }

  async getUpdates(input: {
    baseUrl: string;
    token: string;
    getUpdatesBuf?: string;
    timeoutMs?: number;
    abortSignal?: AbortSignal;
  }) {
    const raw = await this.post({
      baseUrl: input.baseUrl,
      endpoint: "ilink/bot/getupdates",
      token: input.token,
      timeoutMs: input.timeoutMs ?? 35_000,
      abortSignal: input.abortSignal,
      label: "微信 ClawBot 拉取消息",
      body: {
        get_updates_buf: input.getUpdatesBuf ?? "",
        base_info: this.baseInfo()
      }
    });
    return JSON.parse(raw) as WechatGetUpdatesResponse;
  }

  async sendText(input: { baseUrl: string; token: string; toUserId: string; contextToken?: string; text: string }) {
    await this.post({
      baseUrl: input.baseUrl,
      endpoint: "ilink/bot/sendmessage",
      token: input.token,
      timeoutMs: 15_000,
      label: "微信 ClawBot 发送消息",
      body: {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: `wechat-bot-${Date.now()}-${randomBytes(4).toString("hex")}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: input.text } }],
          context_token: input.contextToken
        },
        base_info: this.baseInfo()
      }
    });
  }

  async notifyStart(input: { baseUrl: string; token: string }) {
    const raw = await this.post({
      baseUrl: input.baseUrl,
      endpoint: "ilink/bot/msg/notifystart",
      token: input.token,
      timeoutMs: 15_000,
      label: "微信 ClawBot 通道上线通知",
      body: { base_info: this.baseInfo() }
    });
    return JSON.parse(raw) as { ret?: number; errmsg?: string };
  }

  async notifyStop(input: { baseUrl: string; token: string }) {
    const raw = await this.post({
      baseUrl: input.baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      token: input.token,
      timeoutMs: 15_000,
      label: "微信 ClawBot 通道下线通知",
      body: { base_info: this.baseInfo() }
    });
    return JSON.parse(raw) as { ret?: number; errmsg?: string };
  }

  defaultBaseUrl() {
    return WechatClawbotApi.fixedBaseUrl;
  }

  private async get(input: { baseUrl: string; endpoint: string; timeoutMs?: number; label: string }) {
    const controller = input.timeoutMs ? new AbortController() : undefined;
    const timer = controller && input.timeoutMs ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined;
    try {
      const response = await fetch(this.url(input.baseUrl, input.endpoint), {
        method: "GET",
        headers: this.commonHeaders(),
        signal: controller?.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${input.label}失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async post(input: {
    baseUrl: string;
    endpoint: string;
    body: unknown;
    token?: string;
    timeoutMs?: number;
    label: string;
    abortSignal?: AbortSignal;
  }) {
    const controller = input.timeoutMs ? new AbortController() : undefined;
    const timer = controller && input.timeoutMs ? setTimeout(() => controller.abort(), input.timeoutMs) : undefined;
    const onAbort = () => controller?.abort();
    if (controller && input.abortSignal) input.abortSignal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(this.url(input.baseUrl, input.endpoint), {
        method: "POST",
        headers: this.headers(input.token),
        body: JSON.stringify(input.body),
        signal: controller?.signal ?? input.abortSignal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${input.label}失败（HTTP ${response.status}）：${text.slice(0, 300)}`);
      return text;
    } finally {
      if (timer) clearTimeout(timer);
      if (controller && input.abortSignal) input.abortSignal.removeEventListener("abort", onAbort);
    }
  }

  private url(baseUrl: string, endpoint: string) {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    return new URL(endpoint, base).toString();
  }

  private headers(token?: string) {
    return {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf8").toString("base64"),
      ...this.commonHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    };
  }

  private commonHeaders() {
    return {
      "iLink-App-Id": WechatClawbotApi.appId,
      "iLink-App-ClientVersion": WechatClawbotApi.appClientVersion
    };
  }

  private baseInfo() {
    return {
      channel_version: "2.4.4",
      bot_agent: WechatClawbotApi.botAgent
    };
  }
}
