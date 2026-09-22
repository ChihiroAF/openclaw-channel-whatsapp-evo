import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { resolveEvoAccount } from "./accounts.js";
import { DEFAULT_WEBHOOK_PATH, WABA_EVO_CHANNEL_ID } from "./constants.js";
import { createWabaEvoHttpHandler } from "./http.js";
import { dispatchWabaEvoInbound } from "./inbound.js";
import { adaptLogger } from "./logger.js";
import { getWabaEvoChannelRuntime } from "./runtime.js";
export async function startWabaEvoGatewayAccount(ctx) {
    const logger = adaptLogger(console);
    if (!ctx.account.configured) {
        throw new Error(`whatsapp-evo channel is not configured for account "${ctx.account.accountId}": ` +
            (ctx.account.configError ?? `channels.${WABA_EVO_CHANNEL_ID} missing in openclaw.json`));
    }
    // 准入配置会静默拦消息的情况，在启动时就喊出来——这是排查"客户发消息 AI 不回"的第一线索
    if (ctx.account.accessWarning !== undefined) {
        logger.warn?.(`[whatsapp-evo] ${ctx.account.accessWarning}`);
    }
    ctx.setStatus({
        accountId: ctx.account.accountId,
        running: true,
        lifecycle: "starting",
        configured: true,
        enabled: ctx.account.enabled,
    });
    const runtime = getWabaEvoChannelRuntime();
    // SAFETY: Gateway 会注入完整 runtime（与官方渠道插件的处理一致）
    const channelRuntime = (ctx.channelRuntime ?? runtime.channel);
    const unregisterRoutes = [];
    try {
        const handler = createWabaEvoHttpHandler({
            logger,
            // 每个请求都重新按**当前配置**解析账户：这样 controller 改写 openclaw.json
            // （例如重新 bind、换 EVO 实例）之后，后续请求直接生效，不必等账户重启。
            dispatch: async (message, instanceName) => {
                const account = resolveEvoAccount({
                    cfg: ctx.cfg,
                    accountId: ctx.account.accountId,
                });
                await dispatchWabaEvoInbound({
                    account,
                    cfg: ctx.cfg,
                    channelRuntime,
                    logger,
                    message,
                    instanceNameFromHeader: instanceName,
                });
            },
        });
        unregisterRoutes.push(registerPluginHttpRoute({
            path: DEFAULT_WEBHOOK_PATH,
            // auth:"plugin" ⇒ 由插件自己管鉴权，网关不校验 gateway token。
            // 我们的入站鉴权策略见需求文档 §7.2（v1 主动接受的债）。
            auth: "plugin",
            match: "exact",
            pluginId: WABA_EVO_CHANNEL_ID,
            source: "whatsapp-evo-gateway",
            accountId: ctx.account.accountId,
            // 重复注册意味着配置/生命周期出了问题，宁可启动失败也不要静默替换
            throwOnFailure: true,
            handler,
        }));
        logger.info?.(`[whatsapp-evo] inbound route registered at ${DEFAULT_WEBHOOK_PATH} for account ` +
            `${ctx.account.accountId} (dmPolicy=${ctx.account.dmPolicy}, ` +
            `allowFrom=${JSON.stringify(ctx.account.allowFrom)}, ` +
            `evoBaseUrl=${ctx.account.evoBaseUrl}, evoInstanceId=${ctx.account.evoInstanceId ?? "<from header>"})`);
        ctx.setStatus(channelReadyPatch({ accountId: ctx.account.accountId }));
        await waitUntilAbort(ctx.abortSignal);
    }
    finally {
        for (const unregister of unregisterRoutes.toReversed()) {
            unregister();
        }
        ctx.setStatus(channelStoppedPatch({ accountId: ctx.account.accountId }));
    }
}
