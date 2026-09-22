/**
 * 渠道插件装配：出站目标解析、消息适配器、会话路由。
 */
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";

import { DEFAULT_ACCOUNT_ID, type ResolvedEvoAccount } from "./accounts.js";
import { createWabaEvoChannelPluginBase, WABA_EVO_CHANNEL_ID } from "./channel-base.js";
import { startWabaEvoGatewayAccount } from "./gateway.js";
import { noopLogger } from "./logger.js";
import { sendEvoText } from "./outbound.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { wabaEvoChannelStatus } from "./status.js";

/**
 * 出站目标规范化：把 agent / 用户写的目标转成纯数字的国际号码。
 *
 * 接受 `whatsapp-evo:8613800138000`、`whatsapp:8613800138000`、`+8613800138000`、
 * `8613800138000@s.whatsapp.net` 等写法，一律归一为纯数字（EVO 的 `number` 字段要求）。
 */
export function normalizeWabaEvoTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutChannel = trimmed
    .replace(/^whatsapp-evo:/i, "")
    .replace(/^whatsapp:/i, "")
    .replace(/^\+/, "");
  const digits = withoutChannel.split("@")[0]?.split(":")[0]?.replace(/[^\d]/g, "") ?? "";
  return /^[0-9]{10,15}$/.test(digits) ? digits : undefined;
}

const wabaEvoMessageAdapter = defineChannelMessageAdapter({
  id: WABA_EVO_CHANNEL_ID,
  durableFinal: { capabilities: { text: true } },
  send: {
    text: async (ctx) => {
      const account = ctx.account as ResolvedEvoAccount;
      const result = await sendEvoText({
        config: {
          evoBaseUrl: account.evoBaseUrl,
          evoApiKey: account.evoApiKey,
          ...(account.evoInstanceId === undefined ? {} : { evoInstanceId: account.evoInstanceId }),
        },
        // ⚠️ 这条路径是 **agent 主动发送**（message 工具 / 定时任务），不是"回复某条入站消息"，
        // 所以**没有** `X-Evo-Instance` 头可依赖 ⇒ 只能落回配置里的 evoInstanceId。
        // 这也是 bind 时**必须**把 evoInstanceId 一起写进 channels.whatsapp-evo 的原因。
        instanceNameFromHeader: "",
        to: ctx.to,
        text: ctx.text,
        logger: noopLogger,
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: WABA_EVO_CHANNEL_ID, messageId: result.messageId }],
          kind: "text",
        }),
      };
    },
  },
});

export const wabaEvoChannelPlugin: ChannelPlugin<ResolvedEvoAccount> = createChatChannelPlugin<
  ResolvedEvoAccount
>({
  base: {
    ...createWabaEvoChannelPluginBase(),
    messaging: {
      normalizeTarget: normalizeWabaEvoTarget,
      // 只有单聊：群消息在 payload 解析阶段就被丢掉，这里不该声明 group
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => normalizeWabaEvoTarget(raw) !== undefined,
        hint: "<digits-e164-without-plus>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const peerId = normalizeWabaEvoTarget(target);
        if (!peerId) {
          return null;
        }
        // recipientSessionExact: 收件人就是会话本身（没有 thread / 群的概念），
        // 否则同一个客户会因为"每次目标写法不同"而落到不同会话。
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: WABA_EVO_CHANNEL_ID,
          accountId,
          recipientSessionExact: true,
          peer: { kind: "direct", id: peerId },
          chatType: "direct",
          from: `${WABA_EVO_CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: peerId,
        });
      },
    },
    status: wabaEvoChannelStatus,
    gateway: {
      startAccount: async (ctx) => await startWabaEvoGatewayAccount(ctx),
    },
    message: wabaEvoMessageAdapter,
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: WABA_EVO_CHANNEL_ID,
      sendText: async ({ account, to, text }) =>
        await sendEvoText({
          config: {
            evoBaseUrl: account.evoBaseUrl,
            evoApiKey: account.evoApiKey,
            ...(account.evoInstanceId === undefined
              ? {}
              : { evoInstanceId: account.evoInstanceId }),
          },
          instanceNameFromHeader: "",
          to,
          text,
          logger: noopLogger,
        }),
    },
  },
});
