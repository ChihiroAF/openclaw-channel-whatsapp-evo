import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";

import { DEFAULT_ACCOUNT_ID, type ResolvedEvoAccount } from "./accounts.js";

/**
 * 渠道状态。
 *
 * ⚠️ 语义提醒：本渠道是**无状态 REST + webhook**（EVO 侧管连接），插件本身不存在长连接，
 * 所以 `running` 只表示"插件已注册好入站路由"，**不代表 EVO 那边可用**。
 * 真正的"能不能收发"取决于 controller 的绑定状态接口。
 *
 * 暴露的 extra 字段刻意**不含 evoApiKey**，只有一个布尔位。
 */
export const wabaEvoChannelStatus = createComputedAccountStatusAdapter<ResolvedEvoAccount>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  buildChannelSummary: ({ snapshot }) => ({
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
  }),
  resolveAccountSnapshot: ({ account }) => ({
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    extra: {
      evoBaseUrl: account.evoBaseUrl,
      evoInstanceId: account.evoInstanceId ?? "",
      dmPolicy: account.dmPolicy,
      allowFrom: account.allowFrom,
      evoApiKeyConfigured: account.evoApiKey !== "",
      // 这两个字符串是排查"客户发消息 AI 不回"的第一手线索
      configError: account.configError ?? "",
      accessWarning: account.accessWarning ?? "",
    },
  }),
});
