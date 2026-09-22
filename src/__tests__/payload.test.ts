import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTimestampSeconds,
  isMessageUpsertEvent,
  normalizeEvoEventName,
  normalizeWhatsAppNumber,
  parseEvoWebhook,
  resolveMessageType,
} from "../payload.js";

/** Evolution v1 形态：event 大写、instance 是对象、messageType 明确声明 */
function v1Payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "MESSAGES_UPSERT",
    instance: { instanceId: "inst-1", instanceName: "inst-1" },
    data: {
      key: {
        id: "wamid.V1",
        remoteJid: "8613800138000@s.whatsapp.net",
        fromMe: false,
      },
      pushName: "客户甲",
      message: { conversation: "你好" },
      messageType: "conversation",
      messageTimestamp: 1789637200,
      ...overrides,
    },
  });
}

/** Evolution v2 形态：event 小写点号、instance 是字符串 */
function v2Payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: "messages.upsert",
    instance: "inst-1",
    data: {
      key: {
        id: "wamid.V2",
        remoteJid: "8613900139000@s.whatsapp.net",
        fromMe: false,
      },
      pushName: "客户乙",
      message: { extendedTextMessage: { text: "在吗" } },
      messageTimestamp: 1789637200,
      ...overrides,
    },
    destination: "8613900139000",
    date_time: "2026-09-22T03:00:00.000Z",
  });
}

test("事件名归一：v1/v2 两种写法都认", () => {
  assert.equal(normalizeEvoEventName("MESSAGES_UPSERT"), "messages.upsert");
  assert.equal(normalizeEvoEventName("messages.upsert"), "messages.upsert");
  assert.equal(normalizeEvoEventName("Messages-Upsert"), "messages.upsert");
  assert.equal(normalizeEvoEventName("  MESSAGES_UPSERT  "), "messages.upsert");
  assert.equal(normalizeEvoEventName(undefined), "");
  assert.equal(normalizeEvoEventName(123), "");

  assert.equal(isMessageUpsertEvent("MESSAGES_UPSERT"), true);
  assert.equal(isMessageUpsertEvent("messages.upsert"), true);
  assert.equal(isMessageUpsertEvent("MESSAGES_UPDATE"), false);
  assert.equal(isMessageUpsertEvent("connection.update"), false);
  assert.equal(isMessageUpsertEvent(""), false);
});

test("号码归一：去掉 @ 后缀与 :设备位", () => {
  assert.equal(normalizeWhatsAppNumber("8613800138000@s.whatsapp.net"), "8613800138000");
  assert.equal(normalizeWhatsAppNumber("8613800138000:12@s.whatsapp.net"), "8613800138000");
  assert.equal(normalizeWhatsAppNumber("8613800138000"), "8613800138000");
  assert.equal(normalizeWhatsAppNumber(" 8613800138000@s.whatsapp.net "), "8613800138000");
});

test("时间戳归一：秒/毫秒/{low} 三种形态，异常返回 undefined", () => {
  assert.equal(extractTimestampSeconds(1789637200), 1789637200);
  assert.equal(extractTimestampSeconds(1789637200000), 1789637200);
  assert.equal(extractTimestampSeconds({ low: 1789637200, high: 0, unsigned: true }), 1789637200);
  assert.equal(extractTimestampSeconds(0), undefined);
  assert.equal(extractTimestampSeconds("1789637200"), undefined);
  assert.equal(extractTimestampSeconds(undefined), undefined);
});

test("messageType 缺失时按 message 键回退推断", () => {
  assert.equal(resolveMessageType({ messageType: "conversation" }, {}), "conversation");
  assert.equal(resolveMessageType({}, { conversation: "hi" }), "conversation");
  assert.equal(resolveMessageType({}, { extendedTextMessage: { text: "hi" } }), "extendedTextMessage");
  assert.equal(resolveMessageType({}, { imageMessage: { url: "x" } }), "imageMessage");
  assert.equal(resolveMessageType({}, {}), "");
});

test("v1 payload：解析出文本、发送者、wamid", () => {
  const result = parseEvoWebhook(v1Payload());
  assert.equal(result.kind, "text");
  if (result.kind !== "text") {
    return;
  }
  assert.equal(result.message.text, "你好");
  assert.equal(result.message.senderNumber, "8613800138000");
  assert.equal(result.message.wamid, "wamid.V1");
  assert.equal(result.message.senderName, "客户甲");
  assert.equal(result.message.timestampSeconds, 1789637200);
  assert.equal(result.message.remoteJid, "8613800138000@s.whatsapp.net");
});

test("v2 payload：小写点号事件名 + instance 为字符串，同样解析成功", () => {
  const result = parseEvoWebhook(v2Payload());
  assert.equal(result.kind, "text");
  if (result.kind !== "text") {
    return;
  }
  assert.equal(result.message.text, "在吗");
  assert.equal(result.message.senderNumber, "8613900139000");
  assert.equal(result.message.wamid, "wamid.V2");
});

test("文本回退：conversation 为空串时用 extendedTextMessage.text", () => {
  const result = parseEvoWebhook(
    v1Payload({ message: { conversation: "", extendedTextMessage: { text: "回退生效" } } }),
  );
  assert.equal(result.kind, "text");
  if (result.kind !== "text") {
    return;
  }
  assert.equal(result.message.text, "回退生效");
});

test("带设备位的 remoteJid 仍能得到正确回复号码", () => {
  const result = parseEvoWebhook(
    v1Payload({
      key: { id: "wamid.DEV", remoteJid: "8613800138000:12@s.whatsapp.net", fromMe: false },
    }),
  );
  assert.equal(result.kind, "text");
  if (result.kind !== "text") {
    return;
  }
  assert.equal(result.message.senderNumber, "8613800138000");
});

test("非消息事件一律跳过（回执 / 连接状态）", () => {
  for (const event of ["MESSAGES_UPDATE", "connection.update", "qrcode.updated"]) {
    const raw = JSON.stringify({ event, data: { key: { id: "x", remoteJid: "861@s.whatsapp.net" } } });
    const result = parseEvoWebhook(raw);
    assert.equal(result.kind, "skip");
    if (result.kind !== "skip") {
      return;
    }
    assert.equal(result.reason, "non_message_event");
  }
});

test("自己发的消息（fromMe）跳过", () => {
  const result = parseEvoWebhook(
    v1Payload({ key: { id: "wamid.ME", remoteJid: "8613800138000@s.whatsapp.net", fromMe: true } }),
  );
  assert.equal(result.kind, "skip");
  assert.equal(result.kind === "skip" ? result.reason : "", "from_me");
});

test("群消息与广播消息跳过", () => {
  const group = parseEvoWebhook(
    v1Payload({ key: { id: "wamid.G", remoteJid: "12345678@g.us", fromMe: false } }),
  );
  assert.equal(group.kind === "skip" ? group.reason : "", "group_message");

  const broadcast = parseEvoWebhook(
    v1Payload({ key: { id: "wamid.B", remoteJid: "status@broadcast", fromMe: false } }),
  );
  assert.equal(broadcast.kind === "skip" ? broadcast.reason : "", "broadcast_message");
});

test("媒体消息识别为 media（v1 只记日志，不投递 AI）", () => {
  const result = parseEvoWebhook(
    v1Payload({ message: { imageMessage: { url: "https://x" } }, messageType: "imageMessage" }),
  );
  assert.equal(result.kind, "media");
  if (result.kind !== "media") {
    return;
  }
  assert.equal(result.mediaType, "imageMessage");
  assert.equal(result.senderNumber, "8613800138000");
});

test("异常输入不抛异常，只返回 skip", () => {
  assert.equal(parseEvoWebhook(undefined).kind, "skip");
  assert.equal(parseEvoWebhook(null).kind, "skip");
  assert.equal(parseEvoWebhook("").kind, "skip");
  assert.equal(parseEvoWebhook("   ").kind, "skip");
  assert.equal(parseEvoWebhook("not-json").kind, "skip");
  assert.equal(parseEvoWebhook("[1,2,3]").kind, "skip");
  assert.equal(parseEvoWebhook("{}").kind, "skip");

  const noKey = parseEvoWebhook(JSON.stringify({ event: "MESSAGES_UPSERT", data: {} }));
  assert.equal(noKey.kind === "skip" ? noKey.reason : "", "no_sender");

  const nonNumeric = parseEvoWebhook(
    v1Payload({ key: { id: "wamid.N", remoteJid: "abc@s.whatsapp.net", fromMe: false } }),
  );
  assert.equal(nonNumeric.kind === "skip" ? nonNumeric.reason : "", "no_sender");

  const emptyMessage = parseEvoWebhook(v1Payload({ message: {}, messageType: "" }));
  assert.equal(emptyMessage.kind === "skip" ? emptyMessage.reason : "", "unsupported_payload");
});

test("payload 为空 body 时跳过（controller 出错时可能推空）", () => {
  const result = parseEvoWebhook(Buffer.from("", "utf8"));
  assert.equal(result.kind === "skip" ? result.reason : "", "empty_body");
});
