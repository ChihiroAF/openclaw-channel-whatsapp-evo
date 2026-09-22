/**
 * 把「字段契约」包装成 openclaw 渠道配置 schema。
 *
 * 字段本身定义在 `config-fields.ts`（纯逻辑、可离线单测）；这里只做 SDK 适配，
 * 所以本文件是本仓库少数几个需要 `openclaw/plugin-sdk/*` 的模块之一。
 *
 * ⚠️ 用 `buildJsonChannelConfigSchema`（收 JSON Schema）而**不是** `buildChannelConfigSchema`
 * （收 Zod）：本插件刻意零运行时依赖（见 README「安装与启用」），
 * 而后者内部会 `z.toJSONSchema(...)`，等于把 zod 又拉回来。
 * 现在运行时 schema 与 `openclaw.plugin.json` 的 `channelConfigs.*.schema` 共用
 * `EVO_CHANNEL_CONFIG_JSON_SCHEMA` 这一份真值，两者漂移由 `manifest-parity.test.ts` 拦住。
 */
import { buildJsonChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { EVO_CHANNEL_CONFIG_JSON_SCHEMA, evoChannelConfigUiHints } from "./config-fields.js";

/** `channels.whatsapp-evo` 的完整 schema（含 UI 提示） */
export const wabaEvoPluginConfigSchema = buildJsonChannelConfigSchema(
  { ...EVO_CHANNEL_CONFIG_JSON_SCHEMA, properties: { ...EVO_CHANNEL_CONFIG_JSON_SCHEMA.properties } },
  { uiHints: { ...evoChannelConfigUiHints } },
);
