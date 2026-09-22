import { maskRecipient } from "./logger.js";
import { EvoClient, toEvoNumber } from "./evo-client.js";
/**
 * 决定出站用哪个 EVO 实例名。
 *
 * 顺序：请求头（controller 转发时下发，权威）→ 配置 `evoInstanceId`（兜底）。
 * 两者都没有时**明确抛错**：静默用错实例的后果是"把消息发到别人的号码上"，比失败严重得多。
 */
export function resolveEvoInstanceName(params) {
    const fromHeader = params.instanceNameFromHeader.trim();
    if (fromHeader !== "") {
        return fromHeader;
    }
    const fromConfig = params.configInstanceName?.trim() ?? "";
    if (fromConfig !== "") {
        return fromConfig;
    }
    throw new Error("EVO instance name is unavailable: no X-Evo-Instance header on the inbound request and no evoInstanceId in channels.whatsapp-evo config");
}
/**
 * 发送一条文本回复。
 *
 * 出错时把 EVO 的原始状态码与响应摘要**原样抛出**（见 `EvoClientError`）：
 * 上层会把它作为 delivery.onError 记录下来，联调时能一眼分辨是插件、EVO 还是 WhatsApp 侧的问题。
 */
export async function sendEvoText(params) {
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
    const result = await client.sendText({ instanceName, number, text: trimmedText });
    // ⚠️ NFR-3：日志里不出现完整号码，只留后四位
    logger.debug?.(`[whatsapp-evo] text sent to ${maskRecipient(number)} via instance ${instanceName} ` +
        `(http=${result.httpStatus}, status=${result.status || "unknown"}, wamid=${result.messageId || "unknown"})`);
    return { messageId: result.messageId, to: number, evoStatus: result.status };
}
