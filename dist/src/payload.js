/**
 * EVO（Evolution API）入站 payload 解析 —— 纯逻辑，不依赖 openclaw SDK。
 *
 * 设计原则（见需求文档 §5.1 与开发文档 §1.4）：
 * - **宽松容错**：字段缺失、类型异常、v1/v2 形态差异都不能抛异常，只能降级成"跳过 + 原因"。
 *   实际推送形态要到联调才能定稿，所以这里宁可多认几种写法。
 * - **不反推出站实例名**：EVO 的 instanceName 由 controller 通过请求头下发（见 gateway/inbound），
 *   v1 payload 里 `instance` 是对象、v2 是字符串，这里**刻意不解析它**。
 * - 事件名与号码归一规则必须与 controller 侧保持一致（`isMessageUpsertEvent` / 号码解析）。
 */
import { EVO_MEDIA_MESSAGE_TYPES, EVO_MESSAGE_TYPE_CONVERSATION, EVO_MESSAGE_TYPE_EXTENDED_TEXT, EVO_MESSAGE_UPSERT_EVENT_NORMALIZED, WHATSAPP_BROADCAST_JID_SUFFIX, WHATSAPP_GROUP_JID_SUFFIX, } from "./constants.js";
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function asNonEmptyString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    return value.trim() === "" ? undefined : value;
}
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
/**
 * 事件名归一：小写化 + 把 `_`、`-` 统一成 `.`。
 * 与 controller 侧 `isMessageUpsertEvent` 的实现逐字对应：
 * v1 的 `MESSAGES_UPSERT` 与 v2 的 `messages.upsert` 都归一到 `messages.upsert`。
 */
export function normalizeEvoEventName(event) {
    if (typeof event !== "string") {
        return "";
    }
    return event.trim().toLowerCase().replace(/[_-]/g, ".");
}
/** 是否为「收到新消息」事件 */
export function isMessageUpsertEvent(event) {
    return normalizeEvoEventName(event) === EVO_MESSAGE_UPSERT_EVENT_NORMALIZED;
}
/**
 * remoteJid → 纯数字国际号码。
 * `8613800138000@s.whatsapp.net`    → `8613800138000`
 * `8613800138000:12@s.whatsapp.net` → `8613800138000`（截掉设备位）
 */
export function normalizeWhatsAppNumber(remoteJid) {
    const beforeAt = remoteJid.split("@")[0] ?? "";
    const beforeDevice = beforeAt.split(":")[0] ?? "";
    return beforeDevice.trim();
}
/** 是否为纯数字（EVO 出站的 number 要求纯数字、不含 +） */
export function isPureNumber(value) {
    return /^\d+$/.test(value);
}
/** messageType 是否属于"媒体类（v1 不投递，只记日志）" */
export function isMediaMessageType(messageType) {
    return EVO_MEDIA_MESSAGE_TYPES.includes(messageType);
}
/**
 * 推断消息类型。
 * 优先用 payload 声明的 `data.messageType`；缺失时按 `data.message` 里出现的键回退推断。
 */
export function resolveMessageType(data, message) {
    const declared = asString(data?.["messageType"]);
    if (declared !== undefined && declared.trim() !== "") {
        return declared;
    }
    if (message === undefined) {
        return "";
    }
    if (message[EVO_MESSAGE_TYPE_CONVERSATION] !== undefined) {
        return EVO_MESSAGE_TYPE_CONVERSATION;
    }
    if (message[EVO_MESSAGE_TYPE_EXTENDED_TEXT] !== undefined) {
        return EVO_MESSAGE_TYPE_EXTENDED_TEXT;
    }
    for (const type of EVO_MEDIA_MESSAGE_TYPES) {
        if (message[type] !== undefined) {
            return type;
        }
    }
    return "";
}
/** 取文本：优先 `message.conversation`，为空则退回 `message.extendedTextMessage.text` */
export function extractText(message) {
    if (message === undefined) {
        return undefined;
    }
    const conversation = asNonEmptyString(message[EVO_MESSAGE_TYPE_CONVERSATION]);
    if (conversation !== undefined) {
        return conversation;
    }
    const extended = asRecord(message[EVO_MESSAGE_TYPE_EXTENDED_TEXT]);
    return asNonEmptyString(extended?.["text"]);
}
/**
 * 取时间戳并归一为秒。
 * v1/v2 可能给数字（秒或毫秒），也可能给 `{low, high}` 形式，取不到返回 undefined。
 */
export function extractTimestampSeconds(value) {
    let raw;
    if (typeof value === "number" && Number.isFinite(value)) {
        raw = value;
    }
    else {
        const low = asRecord(value)?.["low"];
        if (typeof low === "number" && Number.isFinite(low)) {
            raw = low;
        }
    }
    if (raw === undefined || raw <= 0) {
        return undefined;
    }
    // > 1e11 视为毫秒（2026 年的秒级时间戳约 1.7e9）
    return raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
}
function toUtf8(rawBody) {
    return typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
}
function skip(reason, wamid) {
    return wamid === undefined ? { kind: "skip", reason } : { kind: "skip", reason, wamid };
}
/**
 * 解析 EVO 入站 payload（controller 转发的原始字节，未做任何改写）。
 *
 * 返回 `skip` 是**正常路径**而非错误：回执/连接状态事件、自己发的消息、群消息、
 * 媒体消息（v1 不投递）都会走到这里，调用方只记日志即可。
 */
export function parseEvoWebhook(rawBody) {
    if (rawBody === undefined || rawBody === null) {
        return skip("empty_body");
    }
    const text = toUtf8(rawBody);
    if (text.trim() === "") {
        return skip("empty_body");
    }
    let payload;
    try {
        payload = JSON.parse(text);
    }
    catch {
        return skip("invalid_json");
    }
    const root = asRecord(payload);
    if (root === undefined) {
        return skip("invalid_json");
    }
    // 事件过滤（controller 入口已拦一层，这里是防御性冗余）
    if (!isMessageUpsertEvent(root["event"])) {
        return skip("non_message_event");
    }
    const data = asRecord(root["data"]);
    const key = asRecord(data?.["key"]);
    const wamid = asString(key?.["id"]);
    const remoteJid = asString(key?.["remoteJid"]);
    if (key?.["fromMe"] === true) {
        return skip("from_me", wamid);
    }
    if (remoteJid === undefined || remoteJid.trim() === "") {
        return skip("no_sender", wamid);
    }
    if (remoteJid.endsWith(WHATSAPP_GROUP_JID_SUFFIX)) {
        return skip("group_message", wamid);
    }
    if (remoteJid.endsWith(WHATSAPP_BROADCAST_JID_SUFFIX)) {
        return skip("broadcast_message", wamid);
    }
    const senderNumber = normalizeWhatsAppNumber(remoteJid);
    if (!isPureNumber(senderNumber)) {
        return skip("no_sender", wamid);
    }
    const message = asRecord(data?.["message"]);
    const messageType = resolveMessageType(data, message);
    if (isMediaMessageType(messageType)) {
        return { kind: "media", wamid: wamid ?? "", senderNumber, mediaType: messageType };
    }
    const body = extractText(message);
    if (body === undefined) {
        return skip("unsupported_payload", wamid);
    }
    const timestampSeconds = extractTimestampSeconds(data?.["messageTimestamp"]);
    return {
        kind: "text",
        message: {
            wamid: wamid ?? "",
            remoteJid,
            senderNumber,
            senderName: asString(data?.["pushName"]) ?? "",
            text: body,
            ...(timestampSeconds === undefined ? {} : { timestampSeconds }),
        },
    };
}
