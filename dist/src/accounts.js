/**
 * 账号解析：把 `channels.whatsapp-evo` 配置段解析成插件内部用的 account 对象。
 *
 * **纯逻辑**（不 import openclaw SDK），所以可以离线单测——这一点对本渠道特别重要：
 * 配置是 controller 在 bind 时写进实例 openclaw.json 的，字段名对不上只会表现为
 * "客户发消息没有回复"，没有任何报错。把解析逻辑做成可测的，是唯一能提前抓住它的办法。
 *
 * `cfg` 刻意按 `unknown` 处理并在内部收窄：这样即使没有安装 openclaw、拿不到它的配置类型，
 * 本模块也能独立编译与测试。
 */
import { checkEvoAccessConfig, evoChannelConfigSchema } from "./config-fields.js";
import { WABA_EVO_CHANNEL_ID } from "./constants.js";
/** v1 只有单账号；保留常量是为了与核心的多账号约定兼容 */
export const DEFAULT_ACCOUNT_ID = "default";
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
/** 取出 `cfg.channels[<channelId>]`（拿不到返回 undefined） */
export function readEvoChannelSection(cfg, channelId = WABA_EVO_CHANNEL_ID) {
    const channels = asRecord(asRecord(cfg)?.["channels"]);
    return asRecord(channels?.[channelId]);
}
/** 取出 `cfg.channels[<channelId>].accounts[<accountId>]`（拿不到返回 undefined） */
function readAccountOverride(section, accountId) {
    if (accountId === DEFAULT_ACCOUNT_ID) {
        return undefined;
    }
    return asRecord(asRecord(section?.["accounts"])?.[accountId]);
}
/**
 * 列出该渠道的账号 id。
 * 配置段不存在时返回空数组（= 未配置），core 会把它当成"没有可用账号"。
 */
export function listEvoAccountIds(cfg) {
    const section = readEvoChannelSection(cfg);
    if (section === undefined) {
        return [];
    }
    const accounts = asRecord(section["accounts"]);
    const ids = accounts === undefined ? [] : Object.keys(accounts).filter((id) => id.trim() !== "");
    return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}
/** 默认账号 id（v1 恒为 `default`） */
export function resolveDefaultEvoAccountId(cfg) {
    const ids = listEvoAccountIds(cfg);
    return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}
/** 组装一个"未配置"的账号对象，避免各处重复写空值 */
function unconfiguredAccount(accountId, reason) {
    return {
        accountId,
        enabled: true,
        configured: false,
        evoBaseUrl: "",
        evoApiKey: "",
        dmPolicy: "pairing",
        allowFrom: [],
        ...(reason === undefined ? {} : { configError: reason }),
    };
}
/**
 * 解析账号。
 *
 * - 配置段缺失/不合法 ⇒ `configured:false` 并带上原因（**不抛异常**：抛异常会让核心在
 *   每次读配置时炸掉，而"未配置"本来就是一个正常状态——插件还没被 bind）。
 * - 凭证**不落日志**：`configError` 只包含 zod 的字段级消息，不含字段值。
 */
export function resolveEvoAccount(params) {
    const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
    const section = readEvoChannelSection(params.cfg);
    if (section === undefined) {
        return unconfiguredAccount(accountId, `channels.${WABA_EVO_CHANNEL_ID} is not present in openclaw.json`);
    }
    // `accounts` 是核心管理的容器键，不属于渠道字段本身，校验前剔除
    const channelLevel = {};
    for (const [key, value] of Object.entries(section)) {
        if (key !== "accounts") {
            channelLevel[key] = value;
        }
    }
    const override = readAccountOverride(section, accountId);
    const merged = { ...channelLevel, ...(override ?? {}) };
    const parsed = evoChannelConfigSchema.safeParse(merged);
    if (!parsed.success) {
        const detail = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
        return unconfiguredAccount(accountId, `invalid channels.${WABA_EVO_CHANNEL_ID} config: ${detail}`);
    }
    const config = parsed.data;
    const accessWarning = checkEvoAccessConfig({
        dmPolicy: config.dmPolicy,
        allowFrom: config.allowFrom,
    });
    return {
        accountId,
        enabled: config.enabled !== false,
        configured: true,
        evoBaseUrl: config.evoBaseUrl,
        evoApiKey: config.evoApiKey,
        ...(config.evoInstanceId === undefined ? {} : { evoInstanceId: config.evoInstanceId }),
        dmPolicy: config.dmPolicy ?? "pairing",
        allowFrom: config.allowFrom ?? [],
        ...(accessWarning === undefined ? {} : { accessWarning }),
    };
}
/** 供 zod 校验失败时做断言用的类型守卫（测试/日志用） */
export function isValidEvoChannelConfig(raw) {
    return evoChannelConfigSchema.safeParse(raw).success;
}
