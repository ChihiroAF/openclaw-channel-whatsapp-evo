/**
 * EVO（Evolution API）出站 REST 客户端 —— 纯逻辑，不依赖 openclaw SDK，可离线单测。
 *
 * 契约来源：`docs/AvatarClaw-WABA-EVO-开发文档.md` §2.5 / §3，以及 2026-09-22 对 UAT 平台的实测
 * （`GET /` 返回 `version: "2.4.0"`，即 Evolution API v2）。
 *
 * 出站请求形态（v1 直连，不经 controller 代理）：
 *
 *   POST {baseUrl}/message/sendText/{instanceName}
 *   apikey: {apiKey}
 *   Content-Type: application/json
 *   { "number": "8613800138000", "text": "..." }
 *
 * ⚠️ 两处版本差异，升级/降级 EVO 时要注意：
 *  1. **body 形态**：v2 用 `text: string`；v1（1.8.x）用 `textMessage: { text }`。
 *     本客户端按 **v2** 发送（平台已确认 2.4.0）。若将来遇到 v1，须改 `buildSendTextBody`。
 *  2. **认证头**：v2 用 `apikey`（全小写）。EVO 全局 key 可操作整个平台，
 *     所以它**只存在实例的 `channels.whatsapp-evo` 配置里**，不进代码、不进日志。
 */
import { EVO_REQUEST_TIMEOUT_MS } from "./constants.js";
import { truncate } from "./logger.js";

/** 客户端配置（由 `channels.whatsapp-evo` 配置段解析而来） */
export type EvoClientConfig = {
  /** EVO 平台基址，如 `https://ev-api.example.com`（尾部斜杠会被规范化掉） */
  baseUrl: string;
  /** EVO 平台的 apikey */
  apiKey: string;
  /** 单次请求超时，默认 `EVO_REQUEST_TIMEOUT_MS` */
  timeoutMs?: number;
  /** 可注入的 fetch（单测用） */
  fetchImpl?: typeof fetch;
};

/** 发送成功的归一化结果 */
export type EvoSendResult = {
  /** EVO 返回的消息 ID（wamid），取不到时为空串 */
  messageId: string;
  /** EVO 返回的 status 字段（通常是 `PENDING`），取不到时为空串 */
  status: string;
  /** HTTP 状态码，便于在日志里区分是"被拒"还是"网络问题" */
  httpStatus: number;
};

/**
 * EVO 请求失败。
 *
 * **刻意保留 HTTP 状态码与响应体摘要**：联调时是三个环节串联（插件 → EVO → WhatsApp），
 * 如果把错误包装成一句话，排查会变成噩梦。上层应把 `httpStatus` 与 `responseExcerpt` 原样记进日志。
 */
export class EvoClientError extends Error {
  readonly httpStatus: number;
  readonly responseExcerpt: string;
  /** 判定为超时（用于区分"EVO 慢"和"EVO 拒了"） */
  readonly timedOut: boolean;

  constructor(message: string, httpStatus: number, responseExcerpt: string, timedOut = false) {
    super(message);
    this.name = "EvoClientError";
    this.httpStatus = httpStatus;
    this.responseExcerpt = responseExcerpt;
    this.timedOut = timedOut;
  }
}

/**
 * 规范化 EVO 基址。
 *
 * - 去首尾空白、去尾部斜杠（否则会拼出 `//message/sendText`，部分网关会 404）
 * - 缺协议时补 `https://`（配置里手填地址最容易漏这个）
 * - 校验必须是 http/https 且能被 `URL` 解析，非法值**尽早抛错**（而不是等到发消息时才失败）
 */
export function normalizeEvoBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("evoBaseUrl is empty (expected e.g. https://ev-api.example.com)");
  }

  // ⚠️ 必须在"补协议"之前拦：否则 `ftp://host` 会被补成 `https://ftp://host`，
  // 而 WHATWG URL 会把它解析成一个"合法"的 `https://ftp//host`（host=ftp、path=//host），
  // 于是拼写错误被静默吞掉，直到发消息失败才暴露。
  const explicitScheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1];
  if (explicitScheme !== undefined && !/^https?$/i.test(explicitScheme)) {
    throw new Error(`evoBaseUrl must be http(s), got scheme: ${explicitScheme}:`);
  }

  const withScheme = explicitScheme === undefined ? `https://${trimmed}` : trimmed;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`evoBaseUrl is not a valid URL: ${truncate(raw, 120)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`evoBaseUrl must be http(s), got: ${parsed.protocol}`);
  }
  // 保留 path（EVO 可能部署在子路径下），只去掉尾部斜杠
  return parsed.toString().replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** EVO v2 的 sendText body（v1 是 `textMessage: { text }`，见文件头注释） */
export function buildSendTextBody(number: string, text: string): Record<string, unknown> {
  return { number, text };
}

/**
 * 从 EVO 响应体里尽力取字段。
 * 各版本字段名不一致，按 `key.id` → `id` → `messageId` 依次尝试，取不到返回空串。
 */
export function extractEvoMessageId(responseBody: unknown): string {
  const root = asRecord(responseBody);
  if (root === undefined) {
    return "";
  }
  const fromKey = asString(asRecord(root["key"])?.["id"]);
  if (fromKey !== undefined && fromKey !== "") {
    return fromKey;
  }
  for (const field of ["id", "messageId"] as const) {
    const value = asString(root[field]);
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  // EVO v2 某些版本把结果包在 data 里
  const nested = asRecord(root["data"]);
  if (nested !== undefined) {
    return extractEvoMessageId(nested);
  }
  return "";
}

/** 从 EVO 响应体里取 status（取不到返回空串） */
export function extractEvoStatus(responseBody: unknown): string {
  const root = asRecord(responseBody);
  const direct = asString(root?.["status"]);
  if (direct !== undefined && direct !== "") {
    return direct;
  }
  const nested = asString(asRecord(root?.["data"])?.["status"]);
  return nested ?? "";
}

/** 出站号码规范化：去掉 `+`、空格、连字符、`@s.whatsapp.net` 后缀与 `:设备位` */
export function toEvoNumber(raw: string): string | undefined {
  const stripped = raw.trim().split("@")[0]?.split(":")[0] ?? "";
  const digits = stripped.replace(/[^\d]/g, "");
  return /^\d+$/.test(digits) && digits !== "" ? digits : undefined;
}

export class EvoClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EvoClientConfig) {
    this.baseUrl = normalizeEvoBaseUrl(config.baseUrl);
    this.apiKey = config.apiKey.trim();
    if (this.apiKey === "") {
      throw new Error("evoApiKey is empty (required for EVO outbound requests)");
    }
    this.timeoutMs = config.timeoutMs ?? EVO_REQUEST_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** 供日志用的基址（不含凭据） */
  get target(): string {
    return this.baseUrl;
  }

  /**
   * 发送文本消息。
   *
   * @param instanceName EVO 侧实例名（= controller 转发的 `X-Evo-Instance` 头；**不是** claw 的 instanceId 之外的猜测值）
   * @param number 客户号码（纯数字国际格式，调用方先过 `toEvoNumber`）
   * @param text 回复正文
   */
  async sendText(params: {
    instanceName: string;
    number: string;
    text: string;
  }): Promise<EvoSendResult> {
    const instanceName = params.instanceName.trim();
    if (instanceName === "") {
      throw new Error("EVO instance name is missing (no X-Evo-Instance header and no evoInstanceId in config)");
    }
    const url = `${this.baseUrl}/message/sendText/${encodeURIComponent(instanceName)}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.apiKey,
        },
        body: JSON.stringify(buildSendTextBody(params.number, params.text)),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      const reason = error instanceof Error ? error.message : String(error);
      throw new EvoClientError(
        timedOut
          ? `EVO sendText timed out after ${this.timeoutMs}ms`
          : `EVO sendText request failed: ${reason}`,
        0,
        "",
        timedOut,
      );
    }

    const rawBody = await response.text();

    if (!response.ok) {
      throw new EvoClientError(
        `EVO sendText rejected with HTTP ${response.status}`,
        response.status,
        truncate(rawBody),
      );
    }

    let parsed: unknown;
    try {
      parsed = rawBody.trim() === "" ? undefined : JSON.parse(rawBody);
    } catch {
      // 201 + 非 JSON 响应体：不视为失败（消息可能已发出），但 messageId 取不到
      parsed = undefined;
    }

    return {
      messageId: extractEvoMessageId(parsed),
      status: extractEvoStatus(parsed),
      httpStatus: response.status,
    };
  }
}
