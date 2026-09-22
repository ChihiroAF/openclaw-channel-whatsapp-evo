/** 把任意外部 logger 适配成本模块的接口（缺失级别降级为 no-op） */
export function adaptLogger(raw) {
    const source = raw;
    const bind = (level) => {
        const fn = source?.[level];
        return typeof fn === "function" ? fn.bind(source) : undefined;
    };
    return {
        debug: bind("debug"),
        info: bind("info"),
        warn: bind("warn"),
        error: bind("error"),
    };
}
/** 什么都不做的 logger（测试/降级用） */
export const noopLogger = {};
/**
 * 号码脱敏（NFR-3：日志里不出现完整客户号码）。
 *
 * `8613800138000` → `*********8000`（只留后四位）
 * 号码过短或非纯数字时退化为全星号，绝不原样输出。
 */
export function maskRecipient(number) {
    const trimmed = number.trim();
    if (trimmed.length <= 4) {
        return "*".repeat(Math.max(trimmed.length, 1));
    }
    return "*".repeat(trimmed.length - 4) + trimmed.slice(-4);
}
/** 把一段文本截断到指定长度，用于日志里放响应体摘要（避免把整页 HTML 打进日志） */
export function truncate(text, max = 512) {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max)}…(truncated, ${text.length} chars total)`;
}
