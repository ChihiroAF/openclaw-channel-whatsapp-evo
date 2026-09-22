/**
 * 把「字段契约」包装成 openclaw 渠道配置 schema。
 *
 * 字段本身定义在 `config-fields.ts`（纯逻辑、可离线单测）；这里只做 SDK 适配，
 * 所以本文件是本仓库少数几个需要 `openclaw/plugin-sdk/*` 的模块之一。
 */
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";

import { evoChannelConfigSchema, evoChannelConfigUiHints } from "./config-fields.js";

/** `channels.whatsapp-evo` 的完整 schema（含 UI 提示） */
export const wabaEvoPluginConfigSchema = buildChannelConfigSchema(evoChannelConfigSchema, {
  uiHints: { ...evoChannelConfigUiHints },
});
