import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  WechatGetUpdatesResponse,
  WechatMessageItem,
  WechatQrResponse,
  WechatQrStatusResponse
} from "./types.js";

export class WechatClawbotApi {
  private static readonly fixedBaseUrl = "https://ilinkai.weixin.qq.com";
  private static readonly botType = "3";
  private static readonly appId = "bot";
  private static readonly appClientVersion = String((2 << 16) | (4 << 8) | 4);
  private static readonly botAgent = "ReusableWechatBot/0.1.0 OpenClaw/2.4.4";
  // Same CDN base the download path uses (cmdDownloadMedia builds
  // https://novac2c.cdn.weixin.qq.com/c2c/download?...); only used when
  // getUploadUrl does not return upload_full_url.
  private static readonly cdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";

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

  async pollLoginStatus(baseUrl: string, qrcode: string, verifyCode?: string, timeoutMs = 75_000) {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;
    const raw = await this.get({ baseUrl, endpoint, label: "微信 ClawBot 扫码状态", timeoutMs });
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
    const raw = await this.post({
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
    // P6 (M3): check ret like sendItem does — an HTTP 200 with ret!=0 is a
    // failed send, not a success, and must never be logged as "sent".
    // 2026-11-12 (C 5a): also check errcode, mirroring pollBot/provisioner
    // (ret+errcode double check). No sendmessage response observed in the
    // repo carries errcode, so the check only fires when the field is
    // present and non-zero — a response without errcode still succeeds.
    const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string; message_id?: string };
    if (parsed.ret !== undefined && parsed.ret !== 0) {
      throw new Error(`微信 ClawBot 发送消息失败（ret=${parsed.ret}）：${parsed.errmsg ?? ""}`);
    }
    if (parsed.errcode !== undefined && parsed.errcode !== 0) {
      throw new Error(`微信 ClawBot 发送消息失败（errcode=${parsed.errcode}）：${parsed.errmsg ?? ""}`);
    }
    return parsed;
  }

  // Send one non-text item (image/video/voice/file) as its own message.
  // Mirrors upstream openclaw-weixin sendMessageItemWeixin: message_type 2
  // (BOT), message_state 2 (FINISH), exactly one entry in item_list.
  async sendItem(input: { baseUrl: string; token: string; toUserId: string; contextToken?: string; item: WechatMessageItem }) {
    const raw = await this.post({
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
          item_list: [input.item],
          context_token: input.contextToken
        },
        base_info: this.baseInfo()
      }
    });
    // 2026-11-12 (C 5a): check errcode as well as ret, mirroring
    // pollBot/provisioner. Only fires when the field is present and
    // non-zero — a response without errcode still succeeds.
    const parsed = JSON.parse(raw) as { ret?: number; errcode?: number; errmsg?: string; message_id?: string };
    if (parsed.ret !== undefined && parsed.ret !== 0) {
      throw new Error(`微信 ClawBot 发送消息失败（ret=${parsed.ret}）：${parsed.errmsg ?? ""}`);
    }
    if (parsed.errcode !== undefined && parsed.errcode !== 0) {
      throw new Error(`微信 ClawBot 发送消息失败（errcode=${parsed.errcode}）：${parsed.errmsg ?? ""}`);
    }
    return parsed;
  }

  // Ask the backend for CDN upload parameters (pre-signed URL) for a file.
  // media_type: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE. aeskey is the 16-byte
  // AES-128 key as 32 hex chars; filesize is the PKCS7-padded ciphertext size.
  async getUploadUrl(input: {
    baseUrl: string;
    token: string;
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  }) {
    const raw = await this.post({
      baseUrl: input.baseUrl,
      endpoint: "ilink/bot/getuploadurl",
      token: input.token,
      timeoutMs: 15_000,
      label: "微信 ClawBot 取 CDN 上传地址",
      body: {
        filekey: input.filekey,
        media_type: input.mediaType,
        to_user_id: input.toUserId,
        rawsize: input.rawsize,
        rawfilemd5: input.rawfilemd5,
        filesize: input.filesize,
        no_need_thumb: true,
        aeskey: input.aeskey,
        base_info: this.baseInfo()
      }
    });
    return JSON.parse(raw) as { upload_param?: string; upload_full_url?: string; thumb_upload_param?: string };
  }

  // Full media upload pipeline (mirrors upstream openclaw-weixin
  // uploadMediaToCdn + uploadBufferToCdn): read file, hash it, make a random
  // AES-128 key, getUploadUrl, AES-128-ECB encrypt, POST the ciphertext to
  // the CDN as application/octet-stream, return the download reference.
  // The aes_key the platform actually issues is base64(32-char hex key) —
  // the same format cmdDownloadMedia already accepts (format 3) — so the
  // value sent here is Buffer.from(aeskeyHex).toString("base64"), i.e. the
  // base64 of the hex string, NOT of the raw 16 bytes.
  async uploadMedia(input: { baseUrl: string; token: string; filePath: string; mediaType: number; toUserId: string }) {
    const { readFile } = await import("node:fs/promises");
    const plaintext = await readFile(input.filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
    const filesize = Math.ceil((rawsize + 1) / 16) * 16;
    const filekey = randomBytes(16).toString("hex");
    const aeskey = randomBytes(16);
    const up = await this.getUploadUrl({
      baseUrl: input.baseUrl,
      token: input.token,
      filekey,
      mediaType: input.mediaType,
      toUserId: input.toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString("hex")
    });
    const uploadFullUrl = up.upload_full_url?.trim();
    if (!uploadFullUrl && !up.upload_param) {
      throw new Error("微信 ClawBot 取 CDN 上传地址失败：未返回 upload_full_url 或 upload_param");
    }
    const cipher = createCipheriv("aes-128-ecb", aeskey, null);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const cdnUrl =
      uploadFullUrl ||
      `${WechatClawbotApi.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(up.upload_param!)}&filekey=${encodeURIComponent(filekey)}`;
    // Up to 3 attempts on server errors; 4xx aborts immediately.
    // P6 (M6): CDN POST has a 30s timeout (a hung CDN must not wedge
    // send-media forever) and exponential backoff between retries (1s, 2s).
    let downloadParam: string | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 2)));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      let res: Response;
      try {
        res = await fetch(cdnUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        continue;
      }
      clearTimeout(timer);
      if (res.status >= 400 && res.status < 500) {
        const msg = res.headers.get("x-error-message") ?? (await res.text()).slice(0, 200);
        throw new Error(`CDN 上传失败（HTTP ${res.status}）：${msg}`);
      }
      if (res.status !== 200) {
        lastError = new Error(`CDN 上传失败（HTTP ${res.status}）`);
        continue;
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) throw new Error("CDN 上传成功但响应缺 x-encrypted-param");
      break;
    }
    if (!downloadParam) {
      throw lastError instanceof Error ? lastError : new Error("CDN 上传失败（3 次重试均未成功）");
    }
    return {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskeyHex: aeskey.toString("hex"),
      fileSize: rawsize,
      fileSizeCiphertext: filesize
    };
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
