/**
 * `channels.whatsapp-evo` 的**字段契约**（纯逻辑，不依赖 openclaw SDK，可离线单测）。
 *
 * 🔴 这里的每个字段名都必须与 controller 的 bind 接口写进实例 openclaw.json 的 key **逐字一致**。
 * 拼错一个字母的后果是：controller 写进去了、插件读不到、**没有任何报错**，
 * 表现只是"客户发消息 AI 不回"。所以这一层单独拆出来做离线单测，而不是混在 SDK 包装里。
 *
 * 与 controller 的对应关系：`internal/logic/channel/bindwabaevologic.go` 的
 * `writeEvoChannelConfig()`（写入端）↔ 本文件（读取端）。
 *
 * ⚠️ **刻意不提供 `webhookPath` 配置项**：入站路由 `/whatsapp-evo/webhook` 是 controller 与插件之间的
 * 固定契约（controller 侧硬编码 `WabaPluginWebhookPath`）。只在一侧做成可配置，等于开了一个
 * "两边不一致就静默收不到消息"的口子。要改路径就两边一起改常量。
 */
import { z } from "zod";
/**
 * 渠道配置 schema。
 *
 * `strict()` 是刻意的：controller 多写一个未声明的字段会**直接报错**，
 * 而不是被静默忽略——把"写错字段名"从静默故障变成显式故障。
 *
 * `accounts` 是核心自己管理的子键（多账号容器），由 accounts.ts 在解析前剔除，故不在此声明。
 */
export const evoChannelConfigSchema = z
    .object({
    enabled: z.boolean().optional(),
    /** EVO 平台基址，如 `https://ev-api.example.com` */
    evoBaseUrl: z.string().min(1, "evoBaseUrl is required (e.g. https://ev-api.example.com)"),
    /** EVO 平台 apikey（全局 key，只存在实例配置里，不进代码、不进日志） */
    evoApiKey: z.string().min(1, "evoApiKey is required"),
    /** EVO 实例名。正常应来自 controller 转发的 `X-Evo-Instance` 头，这里只作兜底 */
    evoInstanceId: z.string().optional(),
    /**
     * 准入策略。⚠️ 核心的默认值是 `pairing`，会**静默拦掉**未配对发送者的消息且不报错，
     * 所以 controller 必须显式写入 `open`；且光有 `open` 还不够，`allowFrom` 必须有通配项 `*`。
     */
    dmPolicy: z.enum(["open", "allowlist", "pairing"]).optional(),
    /** 允许的发送者名单；`["*"]` 表示不限制（与 dmPolicy:open 配套） */
    allowFrom: z.array(z.string()).optional(),
})
    .strict();
/** bind 时 controller 必须写入的字段（缺任何一个渠道都不工作；供测试与文档引用） */
export const EVO_CHANNEL_CONFIG_REQUIRED_FIELDS = ["evoBaseUrl", "evoApiKey"];
/**
 * bind 时 controller 一起写入的准入字段。
 * 单独列出来是为了让"必须配准入"这件事在代码里可见——漏了它的表现是静默不回消息。
 */
export const EVO_CHANNEL_ACCESS_FIELDS = {
    dmPolicy: "open",
    allowFrom: ["*"],
};
/** 字段的 UI 提示（与 openclaw.plugin.json 的 uiHints 保持一致） */
export const evoChannelConfigUiHints = {
    evoBaseUrl: {
        label: "EVO base URL",
        help: "Evolution API base URL, e.g. https://ev-api.example.com. Written by the controller at bind time.",
    },
    evoApiKey: {
        label: "EVO API key",
        help: "Evolution API global key. Stored in the instance's openclaw.json only — never logged.",
        sensitive: true,
    },
    evoInstanceId: {
        label: "EVO instance name",
        help: "Fallback EVO instance name. Normally taken from the X-Evo-Instance header on inbound requests.",
        advanced: true,
    },
    dmPolicy: {
        label: "DM policy",
        help: "open replies to everyone (requires allowFrom to contain \"*\"); pairing/allowlist restrict senders.",
    },
    allowFrom: {
        label: "Allowed senders",
        help: 'Use ["*"] together with dmPolicy "open". An absent list plus pairing silently blocks every customer.',
    },
    enabled: { label: "Enabled", advanced: true },
};
/**
 * 准入配置是否有"会静默拦掉客户消息"的风险。
 *
 * 依据（回 openclaw 源码核实，见开发文档 §2.4.1）：
 * - `src/channels/direct-dm-access.ts` 的 `dmPolicy ?? "pairing"`
 * - `src/channels/message-access/sender-gates.ts` 在 pairing/allowlist 下对未配对发送者 `block-dispatch`
 * - 且即使 dmPolicy=open，仍要求 allowFrom 含通配项 `*`，否则落 `dm_policy_not_allowlisted`
 *
 * 返回 `undefined` 表示没问题；否则返回一句可直接写进日志的告警。
 */
export function checkEvoAccessConfig(config) {
    const dmPolicy = config.dmPolicy ?? "pairing";
    if (dmPolicy !== "open") {
        return (`dmPolicy is "${dmPolicy}" (core default when absent). Inbound customer messages will be dropped ` +
            `without any error — set dmPolicy "open" plus allowFrom ["*"] at bind time.`);
    }
    const allowFrom = config.allowFrom ?? [];
    if (!allowFrom.includes("*")) {
        return (`dmPolicy is "open" but allowFrom=${JSON.stringify(allowFrom)} has no wildcard. ` +
            `Core will still block every sender (dm_policy_not_allowlisted) with no error — add "*" to allowFrom.`);
    }
    return undefined;
}
