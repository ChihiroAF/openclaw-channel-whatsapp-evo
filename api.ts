/** 业务侧导出面（给 controller / 运维脚本 / 联调用的稳定入口）。 */
export {
  DEFAULT_ACCOUNT_ID,
  isValidEvoChannelConfig,
  listEvoAccountIds,
  readEvoChannelSection,
  resolveDefaultEvoAccountId,
  resolveEvoAccount,
  type ResolvedEvoAccount,
} from "./src/accounts.js";
export { wabaEvoChannelPlugin, normalizeWabaEvoTarget } from "./src/channel.js";
export {
  EVO_CHANNEL_ACCESS_FIELDS,
  EVO_CHANNEL_CONFIG_REQUIRED_FIELDS,
  checkEvoAccessConfig,
  type EvoChannelConfig,
} from "./src/config-fields.js";
export {
  DEFAULT_WEBHOOK_PATH,
  EVO_INSTANCE_HEADER,
  WABA_EVO_CHANNEL_ID,
} from "./src/constants.js";
export {
  EvoClient,
  EvoClientError,
  normalizeEvoBaseUrl,
  toEvoNumber,
  type EvoSendResult,
} from "./src/evo-client.js";
export {
  isMessageUpsertEvent,
  normalizeEvoEventName,
  normalizeWhatsAppNumber,
  parseEvoWebhook,
  type EvoParseResult,
  type EvoTextMessage,
} from "./src/payload.js";
export { getWabaEvoChannelRuntime, setWabaEvoChannelRuntime } from "./src/runtime.js";
