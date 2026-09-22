/**
 * 渠道插件骨架（id / meta / capabilities / reload / configSchema / config）。
 *
 * 契约见 `docs/AvatarClaw-WABA-EVO-需求文档-最终版.md` 与开发文档 §2。
 */
import { createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import { listEvoAccountIds, resolveDefaultEvoAccountId, resolveEvoAccount, } from "./accounts.js";
import { wabaEvoPluginConfigSchema } from "./config-schema.js";
import { WABA_EVO_CHANNEL_ID, WABA_EVO_CHANNEL_META } from "./constants.js";
export { WABA_EVO_CHANNEL_ID };
export function createWabaEvoChannelPluginBase() {
    return createChannelPluginBase({
        id: WABA_EVO_CHANNEL_ID,
        meta: { ...WABA_EVO_CHANNEL_META },
        // ⚠️ 只声明 direct：我们的入站解析会在更早一步丢掉群消息（`@g.us`）与广播消息，
        // 声明 "group" 只会让核心把不可能出现的东西也路由进来。
        capabilities: { chatTypes: ["direct"] },
        // ★ 热加载的技术保证：controller 在 bind 时改完实例 openclaw.json，
        // 核心据此前缀重读配置，**不需要重建 Pod**。
        reload: { configPrefixes: [`channels.${WABA_EVO_CHANNEL_ID}`] },
        configSchema: wabaEvoPluginConfigSchema,
        config: {
            listAccountIds: (cfg) => listEvoAccountIds(cfg),
            resolveAccount: (cfg, accountId) => resolveEvoAccount({ cfg, accountId }),
            defaultAccountId: (cfg) => resolveDefaultEvoAccountId(cfg),
            isConfigured: (account) => account.configured,
            isEnabled: (account) => account.enabled,
            // ⚠️ 核心的准入判定要求 allowFrom 里含通配项 `*`（即使 dmPolicy 是 open），
            // 否则客户消息会被静默丢弃（`dm_policy_not_allowlisted`）。
            // controller 在 bind 时会写入 `allowFrom: ["*"]`，这里原样透出即可。
            resolveAllowFrom: ({ cfg, accountId }) => resolveEvoAccount({ cfg, accountId }).allowFrom,
        },
    });
}
