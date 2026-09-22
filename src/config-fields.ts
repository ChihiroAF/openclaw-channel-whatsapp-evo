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
 *
 * ⚠️ **本文件刻意零依赖（不再用 zod）**，原因见 README「安装与启用」：
 * 插件是通过 `openclaw plugins install git:…` 装的，而该路径会在克隆后跑一次
 * `npm install --omit=dev`（`src/plugins/git-install.ts`）。只要还有一个运行时依赖，
 * 实例就必须能访问 npm registry —— 而 npm 12 起 `allow-remote` 默认为 `none`，
 * lockfile 里指向别的 registry 的 `resolved` 会被判成 remote 类型直接拒装（`EALLOWREMOTE`）。
 * 把手写校验留在本文件，既去掉了这个网络依赖，也保住了"纯逻辑可离线单测"。
 */

/** 校验通过后的渠道配置（= controller 写入端的字段集） */
export type EvoChannelConfig = {
  enabled?: boolean;
  evoBaseUrl: string;
  evoApiKey: string;
  evoInstanceId?: string;
  dmPolicy?: EvoDmPolicy;
  allowFrom?: string[];
};

/** 核心认的三种私聊准入策略 */
export type EvoDmPolicy = "open" | "allowlist" | "pairing";

/** 字段级校验失败项（只带字段路径与消息，**从不带字段值**——凭证不落日志） */
export type EvoConfigIssue = {
  path: (string | number)[];
  message: string;
};

/**
 * 已声明的字段。**多写未声明的字段会报错而不是静默忽略**
 * （等价于原 zod schema 的 `.strict()`）——把"controller 写错字段名"从静默故障变成显式故障。
 *
 * `accounts` 是核心自己管理的子键（多账号容器），由 accounts.ts 在解析前剔除，故不在此声明。
 */
const DECLARED_KEYS = new Set([
  "enabled",
  "evoBaseUrl",
  "evoApiKey",
  "evoInstanceId",
  "dmPolicy",
  "allowFrom",
]);

const DM_POLICIES: readonly string[] = ["open", "allowlist", "pairing"];

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

/** 数组元素是否全为 string */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 结果类型：成功给出配置，失败给出**仅含路径与消息**的问题清单 */
export type ParseEvoChannelConfigResult =
  | { ok: true; data: EvoChannelConfig }
  | { ok: false; issues: EvoConfigIssue[] };

/**
 * 校验并归一化渠道配置段。
 *
 * 语义与原先的 zod schema 逐条对齐（含字段顺序与必填性）：
 * - 根必须是对象；未声明字段 → 报错（strict）
 * - `evoBaseUrl` / `evoApiKey` 必填且非空字符串
 * - 其余字段可选，类型不符即报错
 */
export function parseEvoChannelConfig(raw: unknown): ParseEvoChannelConfigResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      ok: false,
      issues: [{ path: [], message: `Expected an object, received ${describeType(raw)}` }],
    };
  }
  const input = raw as Record<string, unknown>;
  const issues: EvoConfigIssue[] = [];

  // 未声明字段（strict）
  const unknownKeys = Object.keys(input).filter((key) => !DECLARED_KEYS.has(key));
  if (unknownKeys.length > 0) {
    issues.push({
      path: [],
      message: `Unrecognized key(s) in object: ${unknownKeys.map((k) => `'${k}'`).join(", ")}`,
    });
  }

  // 必填字符串
  const requiredStrings: Array<{ key: "evoBaseUrl" | "evoApiKey"; required: string }> = [
    {
      key: "evoBaseUrl",
      required: "evoBaseUrl is required (e.g. https://ev-api.example.com)",
    },
    { key: "evoApiKey", required: "evoApiKey is required" },
  ];
  const resolvedStrings: Partial<Record<"evoBaseUrl" | "evoApiKey", string>> = {};
  for (const { key, required } of requiredStrings) {
    const value = input[key];
    if (value === undefined) {
      issues.push({ path: [key], message: "Required" });
      continue;
    }
    if (typeof value !== "string") {
      issues.push({ path: [key], message: `Expected string, received ${describeType(value)}` });
      continue;
    }
    if (value.length === 0) {
      issues.push({ path: [key], message: required });
      continue;
    }
    resolvedStrings[key] = value;
  }

  // 可选：boolean
  let enabled: boolean | undefined;
  if (input["enabled"] !== undefined) {
    const value = input["enabled"];
    if (typeof value !== "boolean") {
      issues.push({ path: ["enabled"], message: `Expected boolean, received ${describeType(value)}` });
    } else {
      enabled = value;
    }
  }

  // 可选：string
  let evoInstanceId: string | undefined;
  if (input["evoInstanceId"] !== undefined) {
    const value = input["evoInstanceId"];
    if (typeof value !== "string") {
      issues.push({
        path: ["evoInstanceId"],
        message: `Expected string, received ${describeType(value)}`,
      });
    } else {
      evoInstanceId = value;
    }
  }

  // 可选：枚举
  let dmPolicy: EvoDmPolicy | undefined;
  if (input["dmPolicy"] !== undefined) {
    const value = input["dmPolicy"];
    if (typeof value !== "string" || !DM_POLICIES.includes(value)) {
      issues.push({
        path: ["dmPolicy"],
        message: `Invalid enum value. Expected 'open' | 'allowlist' | 'pairing', received ${JSON.stringify(value)}`,
      });
    } else {
      dmPolicy = value as EvoDmPolicy;
    }
  }

  // 可选：string[]
  let allowFrom: string[] | undefined;
  if (input["allowFrom"] !== undefined) {
    const value = input["allowFrom"];
    if (!isStringArray(value)) {
      issues.push({
        path: ["allowFrom"],
        message: `Expected string[], received ${describeType(value)}`,
      });
    } else {
      allowFrom = value;
    }
  }

  if (issues.length > 0 || resolvedStrings.evoBaseUrl === undefined || resolvedStrings.evoApiKey === undefined) {
    return { ok: false, issues };
  }

  const data: EvoChannelConfig = {
    evoBaseUrl: resolvedStrings.evoBaseUrl,
    evoApiKey: resolvedStrings.evoApiKey,
    ...(enabled === undefined ? {} : { enabled }),
    ...(evoInstanceId === undefined ? {} : { evoInstanceId }),
    ...(dmPolicy === undefined ? {} : { dmPolicy }),
    ...(allowFrom === undefined ? {} : { allowFrom }),
  };
  return { ok: true, data };
}

/** bind 时 controller 必须写入的字段（缺任何一个渠道都不工作；供测试与文档引用） */
export const EVO_CHANNEL_CONFIG_REQUIRED_FIELDS = ["evoBaseUrl", "evoApiKey"] as const;

/**
 * bind 时 controller 一起写入的准入字段。
 * 单独列出来是为了让"必须配准入"这件事在代码里可见——漏了它的表现是静默不回消息。
 */
export const EVO_CHANNEL_ACCESS_FIELDS = {
  dmPolicy: "open",
  allowFrom: ["*"],
} as const;

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
} as const;

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
export function checkEvoAccessConfig(config: {
  dmPolicy?: string | undefined;
  allowFrom?: string[] | undefined;
}): string | undefined {
  const dmPolicy = config.dmPolicy ?? "pairing";
  if (dmPolicy !== "open") {
    return (
      `dmPolicy is "${dmPolicy}" (core default when absent). Inbound customer messages will be dropped ` +
      `without any error — set dmPolicy "open" plus allowFrom ["*"] at bind time.`
    );
  }
  const allowFrom = config.allowFrom ?? [];
  if (!allowFrom.includes("*")) {
    return (
      `dmPolicy is "open" but allowFrom=${JSON.stringify(allowFrom)} has no wildcard. ` +
      `Core will still block every sender (dm_policy_not_allowlisted) with no error — add "*" to allowFrom.`
    );
  }
  return undefined;
}
