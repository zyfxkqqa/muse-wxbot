export interface WechatQrResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface WechatQrStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface WechatMediaRef {
  aes_key?: string;
  full_url?: string;
  encrypted_query_param?: string;
  file_name?: string;
  md5?: string;
  len?: number;
  text?: string; // 语音的服务端转写文字
}

export interface WechatMessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: WechatMediaRef };
  voice_item?: { media?: WechatMediaRef; text?: string };
  file_item?: { media?: WechatMediaRef; file_name?: string; md5?: string; len?: number };
  video_item?: { media?: WechatMediaRef };
}

export interface WechatMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  item_list?: WechatMessageItem[];
  context_token?: string;
}

export interface WechatGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WechatBotBinding {
  id: string;
  platform: "WECHAT";
  platformBotId: string;
  token: string;
  baseUrl: string;
  ownerExternalId: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WechatProvisionStatus {
  phase:
    | "WECHAT_GENERATING_QR"
    | "WECHAT_WAITING_FOR_SCAN"
    | "WECHAT_SCANNED"
    | "WECHAT_CONFIRMED"
    | "WECHAT_FAILED";
  qrImageDataUrl?: string;
  qrValue?: string;
  message?: string;
  lastPollTimeoutAt?: string;
}

export interface WechatIncomingTextMessage {
  botId: string;
  fromUserId: string;
  conversationId: string;
  messageId: string;
  messageType: string;
  text: string;
  raw: WechatMessage;
}

export interface WechatBotStore {
  save(binding: WechatBotBinding): Promise<WechatBotBinding>;
  listActive(): Promise<WechatBotBinding[]>;
  markError?(botId: string, error: string): Promise<void>;
  clearError?(botId: string): Promise<void>;
}

export type WechatMessageHandler = (
  message: WechatIncomingTextMessage,
  bot: WechatBotBinding
) => Promise<string | void | { reply?: string | null }>;
