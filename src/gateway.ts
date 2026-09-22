/**
 * 渠道网关：注册入站 HTTP 路由，并保持账户"运行中"直到被要求停止。
 *
 * ★ 路由为什么注册在这里、而不是插件入口：
 *   `registerPluginHttpRoute` 与**账户生命周期**绑定。放在入口里会出现
 *   "账户没启动路由却已经在"以及重复注册被静默替换。官方写法就是在本函数里注册。
 *
 * ★ 为什么必须 `await waitUntilAbort(ctx.abortSignal)`：
 *   直接 `return` 会被核心当成"账户已停止"，紧接着我们的 `finally` 会把路由注销掉 ⇒
 *   表现是"路由注册成功的日志打出来了，但消息一条都收不到"。
 *
 * ★ 配置热加载（bind 写配置后如何生效）：
 *   插件在 `reload.configPrefixes` 里声明了 `channels.whatsapp-evo`，核心的
 *   `config-reload-plan` 会把它判为 `hot`（`src/gateway/config-reload-plan.ts:310-318`）
 *   ⇒ controller 在 bind 时改写实例 openclaw.json 后，本函数会**重新执行**，
 *   带着新配置重新注册路由。**不需要重启 Pod**。
 *
 * ★ 未配置时的行为（依赖 `listAccountIds` 的语义）：
 *   - 配置段**不存在**（从未 bind）⇒ `listAccountIds` 返回空数组 ⇒ 核心根本不会启动本账户，
 *     不会产生任何错误噪声。这一点很重要：不是所有 claw 都是 WhatsApp claw。
 *   - 配置段**存在但不合法**（例如少写 evoApiKey）⇒ 这里**必须抛错**，让问题可见；
 *     静默跳过只会变成"绑定看着成功、消息全丢"。
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";

import { resolveEvoAccount, type ResolvedEvoAccount } from "./accounts.js";
import { DEFAULT_WEBHOOK_PATH, WABA_EVO_CHANNEL_ID } from "./constants.js";
import { createWabaEvoHttpHandler } from "./http.js";
import { dispatchWabaEvoInbound } from "./inbound.js";
import { adaptLogger } from "./logger.js";
import { getWabaEvoChannelRuntime } from "./runtime.js";

export async function startWabaEvoGatewayAccount(
  ctx: ChannelGatewayContext<ResolvedEvoAccount>,
): Promise<void> {
  const logger = adaptLogger(console);

  if (!ctx.account.configured) {
    throw new Error(
      `whatsapp-evo channel is not configured for account "${ctx.account.accountId}": ` +
        (ctx.account.configError ?? `channels.${WABA_EVO_CHANNEL_ID} missing in openclaw.json`),
    );
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
  const channelRuntime = (ctx.channelRuntime ?? runtime.channel) as PluginRuntime["channel"];

  const unregisterRoutes: Array<() => void> = [];

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

    unregisterRoutes.push(
      registerPluginHttpRoute({
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
      }),
    );

    logger.info?.(
      `[whatsapp-evo] inbound route registered at ${DEFAULT_WEBHOOK_PATH} for account ` +
        `${ctx.account.accountId} (dmPolicy=${ctx.account.dmPolicy}, ` +
        `allowFrom=${JSON.stringify(ctx.account.allowFrom)}, ` +
        `evoBaseUrl=${ctx.account.evoBaseUrl}, evoInstanceId=${ctx.account.evoInstanceId ?? "<from header>"})`,
    );

    ctx.setStatus(channelReadyPatch({ accountId: ctx.account.accountId }));
    await waitUntilAbort(ctx.abortSignal);
  } finally {
    for (const unregister of unregisterRoutes.toReversed()) {
      unregister();
    }
    ctx.setStatus(channelStoppedPatch({ accountId: ctx.account.accountId }));
  }
}
