/**
 * 插件入口（外部插件形态）。
 *
 * 渠道插件必须用 `defineChannelPluginEntry`：它会
 *   1. `api.registerChannel({ plugin })` —— 让核心认识这个渠道（dmPolicy / message 工具 / session 绑定都依赖它）；
 *   2. `setRuntime(api.runtime)` —— 把运行时交给 gateway 的 HTTP handler 使用。
 *
 * ⚠️ **不在入口里注册 HTTP 路由**：入站路由由 `gateway.startAccount` 通过
 * `registerPluginHttpRoute` 注册（与账户生命周期绑定）。在入口里注册会导致
 * "账户没启动路由却已经在"以及"重复注册被静默替换"。
 */
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";

import { wabaEvoChannelPlugin } from "./src/channel.js";
import { wabaEvoPluginConfigSchema } from "./src/config-schema.js";
import { WABA_EVO_CHANNEL_ID } from "./src/constants.js";
import { setWabaEvoChannelRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: WABA_EVO_CHANNEL_ID,
  name: "WhatsApp (via EVO)",
  description:
    "WhatsApp channel through the EVO platform (Evolution API): the controller forwards EVO events to this plugin, which answers customer messages with the agent and replies via EVO.",
  plugin: wabaEvoChannelPlugin,
  configSchema: () => wabaEvoPluginConfigSchema,
  setRuntime: setWabaEvoChannelRuntime,
});
