/**
 * 出站发送：agent 的回复 → EVO → WhatsApp 客户。
 *
 * 与旧版（Meta Cloud API）的关键差异：
 *  - 发送目标用的是**客户号码**（纯数字国际格式），不是 wamid；wamid 只做日志串联。
 *  - 认证是 EVO 平台的 `apikey`，而不是平台侧的 OAuth 长令牌；且**只存在实例配置里**。
 *  - 实例名（EVO 的 instanceName）来自 controller 转发的 `X-Evo-Instance` 头；配置里的
 *    `evoInstanceId` 只作兜底（v1 回复链路够用，将来做主动推送/重试时才有价值）。
 */
import type { ChannelLogger } from "./logger.js";
import { maskRecipient } from "./logger.js";
import { EvoClient, toEvoNumber, type EvoSendResult } from "./evo-client.js";

/** `channels.whatsapp-evo` 配置段（bind 时由 controller 写入实例的 openclaw.json） */
export type EvoChannelConfig = {
  evoBaseUrl: string;
  evoApiKey: string;
  /** 可选兜底：EVO 实例名（正常应来自 `X-Evo-Instance` 头） */
  evoInstanceId?: string;
};

export type SendEvoTextParams = {
  config: EvoChannelConfig;
  /** controller 转发的 `X-Evo-Instance` 头原值，缺失时传空串 */
  instanceNameFromHeader: string;
  /** 客户号码（可带 `@s.whatsapp.net` 后缀，内部会规范化） */
  to: string;
  text: string;
  logger: ChannelLogger;
  fetchImpl?: typeof fetch;
};

export type SendEvoTextResult = {
  messageId: string;
  to: string;
  evoStatus: string;
};

/**
 * 决定出站用哪个 EVO 实例名。
 *
 * 顺序：请求头（controller 转发时下发，权威）→ 配置 `evoInstanceId`（兜底）。
 * 两者都没有时**明确抛错**：静默用错实例的后果是"把消息发到别人的号码上"，比失败严重得多。
 */
export function resolveEvoInstanceName(params: {
  instanceNameFromHeader: string;
  configInstanceName?: string | undefined;
}): string {
  const fromHeader = params.instanceNameFromHeader.trim();
  if (fromHeader !== "") {
    return fromHeader;
  }
  const fromConfig = params.configInstanceName?.trim() ?? "";
  if (fromConfig !== "") {
    return fromConfig;
  }
  throw new Error(
    "EVO instance name is unavailable: no X-Evo-Instance header on the inbound request and no evoInstanceId in channels.whatsapp-evo config",
  );
}

/**
 * 发送一条文本回复。
 *
 * 出错时把 EVO 的原始状态码与响应摘要**原样抛出**（见 `EvoClientError`）：
 * 上层会把它作为 delivery.onError 记录下来，联调时能一眼分辨是插件、EVO 还是 WhatsApp 侧的问题。
 */
export async function sendEvoText(params: SendEvoTextParams): Promise<SendEvoTextResult> {
  const { config, to, text, logger } = params;

  const number = toEvoNumber(to);
  if (number === undefined) {
    throw new Error(`cannot resolve a valid EVO recipient number from: ${maskRecipient(to)}`);
  }

  const trimmedText = text.trim();
  if (trimmedText === "") {
    // 空回复不发送：调用 EVO 只会浪费一次请求，且可能触发平台侧校验错误
    throw new Error("refusing to send an empty text reply");
  }

  const instanceName = resolveEvoInstanceName({
    instanceNameFromHeader: params.instanceNameFromHeader,
    configInstanceName: config.evoInstanceId,
  });

  const client = new EvoClient({
    baseUrl: config.evoBaseUrl,
    apiKey: config.evoApiKey,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  const result: EvoSendResult = await client.sendText({ instanceName, number, text: trimmedText });

  // ⚠️ NFR-3：日志里不出现完整号码，只留后四位
  logger.debug?.(
    `[whatsapp-evo] text sent to ${maskRecipient(number)} via instance ${instanceName} ` +
      `(http=${result.httpStatus}, status=${result.status || "unknown"}, wamid=${result.messageId || "unknown"})`,
  );

  return { messageId: result.messageId, to: number, evoStatus: result.status };
}
