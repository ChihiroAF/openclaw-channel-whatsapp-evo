/**
 * 冻结契约常量。
 *
 * ⚠️ 这里的每一个值都与 `openclaw-controller` 侧的
 * `internal/logic/channel/wabawebhooklogic.go`（转发路径、`X-Evo-Instance` 头、事件名判定）
 * 以及 `docs/AvatarClaw-WABA-EVO-开发文档.md` 逐字对应。
 * 改任何一个都要两边同步，否则表现是"配置写进去了却不工作"且没有任何报错。
 */

/** openclaw.json 的 channels.<id> / package.json 的 openclaw.channel.id */
export const WABA_EVO_CHANNEL_ID = "whatsapp-evo";

/** 渠道展示信息（与 package.json 的 openclaw.channel 保持一致） */
export const WABA_EVO_CHANNEL_META = {
  id: WABA_EVO_CHANNEL_ID,
  label: "WhatsApp (via EVO)",
  selectionLabel: "WhatsApp (via EVO)",
  docsPath: "/channels/whatsapp-evo",
  docsLabel: "whatsapp-evo",
  blurb:
    "WhatsApp through the EVO platform (Evolution API): EVO handles Meta verification, dedupe and delivery; this plugin answers customer messages with the agent.",
  order: 77,
} as const;

/**
 * 实例内注册的入站路由。
 * controller 会把 EVO 的事件**原样**转发到这里（见 controller 侧 `WabaPluginWebhookPath`）。
 *
 * ⚠️ 路径里的 `whatsapp-evo` 与**渠道 id** 保持同一个词：本仓库不再出现 `waba-evo`
 * （`waba` 只作为功能命名空间出现在 controller 对 EVO 的公开回调路径 `/api/v1/waba/webhook/…` 与项目文档名里）。
 */
export const DEFAULT_WEBHOOK_PATH = "/whatsapp-evo/webhook";

/** controller 转发时下发的出站实例名请求头（EVO 的 instanceName） */
export const EVO_INSTANCE_HEADER = "x-evo-instance";

/** 入站 body 上限，与 controller 侧对齐（1MB） */
export const MAX_WEBHOOK_BODY_BYTES = 1 << 20;

/** 出站 EVO 请求超时 */
export const EVO_REQUEST_TIMEOUT_MS = 15_000;

/** WhatsApp 私聊 JID 后缀 */
export const WHATSAPP_USER_JID_SUFFIX = "@s.whatsapp.net";
/** 群聊 JID 后缀（v1 直接丢弃群消息） */
export const WHATSAPP_GROUP_JID_SUFFIX = "@g.us";
/** 广播/状态 JID 后缀（"status@broadcast"），不投递 */
export const WHATSAPP_BROADCAST_JID_SUFFIX = "@broadcast";

/**
 * EVO 侧「收到新消息」事件名。
 * ⚠️ Evolution API v1 用 `MESSAGES_UPSERT`，v2 用 `messages.upsert`；
 * 实测 (2026-09-22) 平台为 2.4.0，但**订阅接口 `/webhook/set` 仍收大写写法**，
 * 而 payload 里的 `event` 字段两种都可能出现 ⇒ 判定必须归一后再比（见 `isMessageUpsertEvent`）。
 */
export const EVO_MESSAGE_UPSERT_EVENT_NORMALIZED = "messages.upsert";

/** v1 缺省消息类型：纯文本 */
export const EVO_MESSAGE_TYPE_CONVERSATION = "conversation";
export const EVO_MESSAGE_TYPE_EXTENDED_TEXT = "extendedTextMessage";

/** v1 只做文本；这些 messageType 记为媒体（只记日志，不投递 AI） */
export const EVO_MEDIA_MESSAGE_TYPES = [
  "imageMessage",
  "audioMessage",
  "videoMessage",
  "documentMessage",
  "documentWithCaptionMessage",
  "stickerMessage",
  "contactMessage",
  "locationMessage",
  "reactionMessage",
  "protocolMessage",
] as const;
