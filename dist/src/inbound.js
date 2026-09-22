/**
 * 入站派发：把规范化后的消息交给 openclaw agent，并把 agent 的回复发回客户（经 EVO）。
 *
 * 机制（三步链路，与核心 `dispatchInboundDirectDm` 同构）：
 *   1. `resolveChannelInboundRouteEnvelope` —— 决定这条消息落在哪个 agent / session；
 *   2. `resolveStableChannelMessageIngress` —— **准入判定**（dmPolicy / allowFrom 在这里生效）；
 *   3. `channelRuntime.inbound.dispatch(...)` —— 真正把 turn 交给 agent；
 *   4. `delivery.deliver(payload, {kind:"final"})` —— 拿最终回复 → 通过 EVO 发回客户。
 *
 * ★ 两个刻意为之的决定：
 *  ① **不传 `dmScope`**：由核心自己从配置的 `session.dmScope` 读取（核心的
 *     `dispatchInboundDirectDm` 也只传 `{cfg, channel, accountId, peer}`）。
 *     骨架里曾硬编码 `per-account-channel-peer`，那会让插件侧的假设与实例配置脱节——
 *     而实例配置里我们写的是 `per-channel-peer`。
 *  ② **插件不再自建一层白名单**：准入完全交给核心。两边各写一套的结果是
 *     "配置说 open、插件却按自己的规则拒绝"，而且现象是静默不回复。
 */
import { buildChannelInboundEventContext, resolveChannelInboundRouteEnvelope, } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { WABA_EVO_CHANNEL_ID } from "./constants.js";
import { maskRecipient } from "./logger.js";
import { sendEvoText } from "./outbound.js";
/** 把一条入站消息派发给 agent。异常由上层（http handler）捕获并记录。 */
export async function dispatchWabaEvoInbound(params) {
    const { account, cfg, channelRuntime, logger, message } = params;
    const peerId = message.senderNumber;
    if (!peerId) {
        logger.warn?.("[whatsapp-evo] inbound message without sender, dropped");
        return;
    }
    const text = message.text;
    // 1. 路由：决定 agentId / sessionKey（dmScope 由核心按配置判定，见文件头注释 ①）
    const { route, buildEnvelope } = resolveChannelInboundRouteEnvelope({
        cfg,
        channel: WABA_EVO_CHANNEL_ID,
        accountId: account.accountId,
        peer: { kind: "direct", id: peerId },
    });
    // 2. 准入判定：dmPolicy / allowFrom 在这里生效
    const ingress = await resolveStableChannelMessageIngress({
        channelId: WABA_EVO_CHANNEL_ID,
        accountId: account.accountId,
        cfg,
        identity: { key: "sender", entryIdPrefix: "whatsapp-evo-entry" },
        subject: { stableId: peerId },
        conversation: { kind: "direct", id: peerId },
        contextBinding: {
            agentId: route.agentId,
            sessionKey: route.sessionKey,
            messageId: message.wamid,
            inboundEventKind: "user_request",
        },
        // 这两个值来自实例 openclaw.json 的 channels.whatsapp-evo，由 controller 在 bind 时写入。
        // ⚠️ dmPolicy 必须是 "open" 且 allowFrom 含 "*"，否则核心会**静默丢弃**客户消息（见 §2.4.1）。
        dmPolicy: account.dmPolicy,
        allowFrom: account.allowFrom,
    });
    if (ingress.ingress.admission !== "dispatch") {
        // 预期行为（例如 dmPolicy=allowlist 且号码不在名单里）：只记日志，不报错
        logger.info?.(`[whatsapp-evo] inbound blocked by channel ingress policy (admission=${ingress.ingress.admission}, ` +
            `dmPolicy=${account.dmPolicy}, sender=${maskRecipient(peerId)})`);
        return;
    }
    // 3. 组装上下文
    const timestamp = message.timestampSeconds;
    const target = `${WABA_EVO_CHANNEL_ID}:${peerId}`;
    const body = buildEnvelope({
        channel: "WhatsApp",
        from: message.senderName || peerId,
        ...(timestamp === undefined ? {} : { timestamp }),
        body: text,
    });
    const ctxPayload = buildChannelInboundEventContext({
        channel: WABA_EVO_CHANNEL_ID,
        accountId: route.accountId ?? account.accountId,
        messageId: message.wamid,
        messageIdFull: message.wamid,
        ...(timestamp === undefined ? {} : { timestamp }),
        from: target,
        sender: {
            id: peerId,
            ...(message.senderName ? { name: message.senderName } : {}),
        },
        conversation: { kind: "direct", id: peerId, label: message.senderName || peerId },
        route: {
            agentId: route.agentId,
            dmScope: route.dmScope,
            accountId: route.accountId,
            routeSessionKey: route.sessionKey,
            dispatchSessionKey: route.sessionKey,
        },
        reply: { to: target, originatingTo: target },
        message: {
            body,
            bodyForAgent: text,
            rawBody: text,
            commandBody: text,
        },
        channelIngress: ingress,
    });
    // 4. 派发，并把最终回复发回客户
    const dispatch = await channelRuntime.inbound.dispatch({
        cfg,
        channel: WABA_EVO_CHANNEL_ID,
        accountId: account.accountId,
        route: { agentId: route.agentId, dmScope: route.dmScope, sessionKey: route.sessionKey },
        ctxPayload,
        delivery: {
            deliver: async (payload, info) => {
                // 只发最终回复：中间态（草稿 / 流式片段）不应变成多条 WhatsApp 消息
                if (info.kind !== "final") {
                    return;
                }
                const replyText = typeof payload.text === "string" ? payload.text : "";
                if (!replyText.trim()) {
                    return;
                }
                await sendEvoText({
                    config: {
                        evoBaseUrl: account.evoBaseUrl,
                        evoApiKey: account.evoApiKey,
                        ...(account.evoInstanceId === undefined
                            ? {}
                            : { evoInstanceId: account.evoInstanceId }),
                    },
                    instanceNameFromHeader: params.instanceNameFromHeader,
                    to: peerId,
                    text: replyText,
                    logger,
                    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
                });
            },
            onError: (error) => {
                logger.error?.(`[whatsapp-evo] agent turn failed: ${error instanceof Error ? error.message : String(error)}`);
            },
        },
        replyPipeline: {},
    });
    if (dispatch.admission.kind !== "dispatch") {
        logger.info?.(`[whatsapp-evo] channel declined the turn: ${dispatch.admission.kind}`);
    }
    else if (!dispatch.dispatched) {
        logger.warn?.("[whatsapp-evo] channel accepted the turn but did not dispatch it");
    }
}
