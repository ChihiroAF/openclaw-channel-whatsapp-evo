/**
 * 渠道运行时（PluginRuntime）的存取。
 *
 * 为什么需要它：HTTP 路由的 handler 与 inbound 派发都不在 `register(api)` 的调用栈里，
 * 拿不到 `api`。通行做法是用 `createPluginRuntimeStore` 存一份运行时句柄，业务代码再取。
 */
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";

import { WABA_EVO_CHANNEL_ID } from "./constants.js";

const { setRuntime, getRuntime } = createPluginRuntimeStore<PluginRuntime>({
  pluginId: WABA_EVO_CHANNEL_ID,
  errorMessage:
    "whatsapp-evo channel runtime not initialized (the plugin entry did not run setRuntime)",
});

export const setWabaEvoChannelRuntime = setRuntime;
export const getWabaEvoChannelRuntime = getRuntime;
