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
import { checkEvoAccessConfig, parseEvoChannelConfig } from "./config-fields.js";
import { WABA_EVO_CHANNEL_ID } from "./constants.js";

/** v1 只有单账号；保留常量是为了与核心的多账号约定兼容 */
export const DEFAULT_ACCOUNT_ID = "default";

/** 解析后的账号（插件内部到处传的对象） */
export type ResolvedEvoAccount = {
  accountId: string;
  /** 核心语义：只有显式 `enabled:false` 才算关闭，缺席视为开启 */
  enabled: boolean;
  /** 凭证齐备（evoBaseUrl + evoApiKey 都合法）时为 true */
  configured: boolean;
  evoBaseUrl: string;
  evoApiKey: string;
  evoInstanceId?: string;
  dmPolicy: string;
  allowFrom: string[];
  /** 配置不合法时的原因（用于 status 展示与启动日志，不含凭证值） */
  configError?: string;
  /** 准入配置会静默拦消息时的告警文案 */
  accessWarning?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 取出 `cfg.channels[<channelId>]`（拿不到返回 undefined） */
export function readEvoChannelSection(
  cfg: unknown,
  channelId: string = WABA_EVO_CHANNEL_ID,
): Record<string, unknown> | undefined {
  const channels = asRecord(asRecord(cfg)?.["channels"]);
  return asRecord(channels?.[channelId]);
}

/** 取出 `cfg.channels[<channelId>].accounts[<accountId>]`（拿不到返回 undefined） */
function readAccountOverride(
  section: Record<string, unknown> | undefined,
  accountId: string,
): Record<string, unknown> | undefined {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return undefined;
  }
  return asRecord(asRecord(section?.["accounts"])?.[accountId]);
}

/**
 * 列出该渠道的账号 id。
 * 配置段不存在时返回空数组（= 未配置），core 会把它当成"没有可用账号"。
 */
export function listEvoAccountIds(cfg: unknown): string[] {
  const section = readEvoChannelSection(cfg);
  if (section === undefined) {
    return [];
  }
  const accounts = asRecord(section["accounts"]);
  const ids = accounts === undefined ? [] : Object.keys(accounts).filter((id) => id.trim() !== "");
  return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
}

/** 默认账号 id（v1 恒为 `default`） */
export function resolveDefaultEvoAccountId(cfg: unknown): string {
  const ids = listEvoAccountIds(cfg);
  return ids.includes(DEFAULT_ACCOUNT_ID) ? DEFAULT_ACCOUNT_ID : (ids[0] ?? DEFAULT_ACCOUNT_ID);
}

/** 组装一个"未配置"的账号对象，避免各处重复写空值 */
function unconfiguredAccount(accountId: string, reason?: string): ResolvedEvoAccount {
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
 * - 凭证**不落日志**：`configError` 只包含字段级消息（字段路径 + 原因），不含字段值。
 */
export function resolveEvoAccount(params: {
  cfg: unknown;
  accountId?: string | undefined;
}): ResolvedEvoAccount {
  const accountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const section = readEvoChannelSection(params.cfg);
  if (section === undefined) {
    return unconfiguredAccount(accountId, `channels.${WABA_EVO_CHANNEL_ID} is not present in openclaw.json`);
  }

  // `accounts` 是核心管理的容器键，不属于渠道字段本身，校验前剔除
  const channelLevel: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section)) {
    if (key !== "accounts") {
      channelLevel[key] = value;
    }
  }
  const override = readAccountOverride(section, accountId);
  const merged = { ...channelLevel, ...(override ?? {}) };

  const parsed = parseEvoChannelConfig(merged);
  if (!parsed.ok) {
    const detail = parsed.issues
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

/** 供校验失败时做断言用的类型守卫（测试/日志用） */
export function isValidEvoChannelConfig(raw: unknown): boolean {
  return parseEvoChannelConfig(raw).ok;
}
