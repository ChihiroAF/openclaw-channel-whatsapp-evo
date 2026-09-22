/**
 * 最小日志接口。
 *
 * 存在的理由：纯逻辑模块（crypto / payload / dedupe / media）不应该依赖 openclaw SDK，
 * 否则它们就无法离线单测。这里定义一个结构化的接口，由 index.ts 用 `api.logger` 适配。
 */
export type ChannelLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

/** 把任意外部 logger 适配成本模块的接口（缺失级别降级为 no-op） */
export function adaptLogger(raw: unknown): ChannelLogger {
  const source = raw as Partial<ChannelLogger> | undefined;
  const bind = (level: keyof ChannelLogger) => {
    const fn = source?.[level];
    return typeof fn === "function" ? (fn as (m: string) => void).bind(source) : undefined;
  };
  return {
    debug: bind("debug"),
    info: bind("info"),
    warn: bind("warn"),
    error: bind("error"),
  };
}

/** 什么都不做的 logger（测试/降级用） */
export const noopLogger: ChannelLogger = {};

/**
 * 号码脱敏（NFR-3：日志里不出现完整客户号码）。
 *
 * `8613800138000` → `*********8000`（只留后四位）
 * 号码过短或非纯数字时退化为全星号，绝不原样输出。
 */
export function maskRecipient(number: string): string {
  const trimmed = number.trim();
  if (trimmed.length <= 4) {
    return "*".repeat(Math.max(trimmed.length, 1));
  }
  return "*".repeat(trimmed.length - 4) + trimmed.slice(-4);
}

/** 把一段文本截断到指定长度，用于日志里放响应体摘要（避免把整页 HTML 打进日志） */
export function truncate(text: string, max = 512): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…(truncated, ${text.length} chars total)`;
}
