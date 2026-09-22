/**
 * 稳定的公共导出面（供其它模块/测试引用，避免直接依赖 src 内部路径）。
 * 形态参照官方渠道插件的 runtime-api.ts。
 */
export type {
  ChannelGatewayContext,
  ChannelPlugin,
  OpenClawConfig,
  PluginRuntime,
} from "./src/runtime-api.js";

export {
  DEFAULT_ACCOUNT_ID,
  listEvoAccountIds,
  resolveDefaultEvoAccountId,
  resolveEvoAccount,
  type ResolvedEvoAccount,
} from "./src/accounts.js";
export { normalizeWabaEvoTarget, wabaEvoChannelPlugin } from "./src/channel.js";
export { DEFAULT_WEBHOOK_PATH, EVO_INSTANCE_HEADER, WABA_EVO_CHANNEL_ID } from "./src/constants.js";
export { getWabaEvoChannelRuntime, setWabaEvoChannelRuntime } from "./src/runtime.js";
