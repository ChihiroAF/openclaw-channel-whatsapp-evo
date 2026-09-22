/**
 * setup 入口。
 *
 * 说明：本渠道的绑定**不由 CLI 向导完成** —— controller 在 bind 时把
 * `channels.whatsapp-evo`（evoBaseUrl / evoApiKey / evoInstanceId / dmPolicy / allowFrom）
 * 写进实例的 openclaw.json。所以这里只需保持 `{ plugin }` 形态，
 * 让核心在 setup-only 模式下也能识别渠道元数据（渠道列表可见、配置校验能跑）。
 */
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { wabaEvoChannelPlugin } from "./src/channel.js";
export default defineSetupPluginEntry(wabaEvoChannelPlugin);
