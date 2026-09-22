/**
 * 闸门：`openclaw.plugin.json` 必须能通过宿主（openclaw）的清单校验。
 *
 * 为什么需要它（2026-09-22 实际踩过）：
 * 清单里写了 `"categories": ["messaging"]`，而 `messaging` **不在**宿主的分类枚举里。
 * 后果不是警告，而是**安装直接失败**：
 *   Installing plugin dependencies with npm…
 *   Linked peerDependency "openclaw" -> /app
 *   [openclaw] The CLI command failed.
 *   [openclaw] Reason: invalid plugin manifest categories: contains unknown category "messaging"
 *   EXIT=1
 * 而且它发生在 **git clone + npm install 之后**（构建产物都已经装好了才校验清单），
 * 所以靠"装一次看一次"来试错，代价是每轮一次完整的实例创建 + 一条真实失败。
 *
 * 校验内容（对齐 `src/plugins/manifest.ts` 的硬失败分支，其余字段缺失只是告警）：
 *   1. 必需 `id`，且不在核心保留列表（当前仅 `node-mcp`）
 *   2. 必需 `configSchema` 且为对象
 *   3. `categories`：1~3 项、无重复、全部属于宿主枚举
 *   4. `channels` 里声明的渠道都必须在 `channelConfigs` 里有对应条目
 *      （缺了不阻断加载，但配置 schema / setup UI 会缺，属"不报错但不好使"）
 *
 * 分类枚举与保留 id 的**真值来源是同级 openclaw 源码**；脚本在能找到源码时会现场解析，
 * 并顺带断言内置兜底列表与源码一致（漂移即失败）。找不到源码（如 CI）时用兜底列表并给出提示。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 真值来源（同级仓库）；可用 OPENCLAW_SOURCE_DIR 覆盖 */
const openclawRoot = process.env.OPENCLAW_SOURCE_DIR ?? join(root, "..", "openclaw");
const categoriesSource = join(
  openclawRoot,
  "packages",
  "plugin-package-contract",
  "src",
  "categories.ts",
);
const manifestSource = join(openclawRoot, "src", "plugins", "manifest.ts");

/**
 * 兜底副本（宿主源码不可用时使用）。
 * 与源码不一致时脚本会失败 —— 所以这里不是"另一个真相"，而是"源码缺席时的下限"。
 */
const FALLBACK_CATEGORY_SLUGS = [
  "channels",
  "models",
  "agent-runtimes",
  "memory",
  "context",
  "voice",
  "web",
  "media",
  "security",
  "integrations",
  "developer-tools",
  "infrastructure",
  "documents-files",
  "inbox-collaboration",
  "productivity",
  "scheduling",
  "finance-payments",
  "sales-marketing",
  "data-analytics",
  "agent-orchestration",
  "research",
  "other",
  // 已发布清单仍可读的历史取值
  "tools",
  "runtime",
  "gateway",
];

const FALLBACK_RESERVED_IDS = ["node-mcp"];

function readTextIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** 抓取 `const NAME = [ ... ] as const;` 里的字符串字面量 */
function extractStringArray(source, constName) {
  const start = source.indexOf(constName);
  if (start < 0) {
    return null;
  }
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  if (open < 0 || close < 0) {
    return null;
  }
  return [...source.slice(open + 1, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const problems = [];
const notes = [];

// ---------- 真值来源 ----------
let allowedCategories = FALLBACK_CATEGORY_SLUGS;
let reservedIds = FALLBACK_RESERVED_IDS;

const categoriesSrc = readTextIfExists(categoriesSource);
if (categoriesSrc) {
  const active = extractStringArray(categoriesSrc, "PLUGIN_CATEGORY_SLUGS");
  const legacy = extractStringArray(categoriesSrc, "LEGACY_PLUGIN_CATEGORY_SLUGS");
  if (!active || !legacy) {
    problems.push(`无法从宿主源码解析分类枚举：${categoriesSource}`);
  } else {
    allowedCategories = [...active, ...legacy];
    // 漂移检测：内置兜底列表与源码不一致 ⇒ 失败（而不是悄悄用过期的列表）
    const drift = [
      ...allowedCategories.filter((s) => !FALLBACK_CATEGORY_SLUGS.includes(s)),
      ...FALLBACK_CATEGORY_SLUGS.filter((s) => !allowedCategories.includes(s)),
    ];
    if (drift.length > 0) {
      problems.push(
        `内置分类兜底列表与宿主源码不一致（漂移：${drift.join(", ")}）。请更新本脚本里的 FALLBACK_CATEGORY_SLUGS。`,
      );
    } else {
      notes.push(`分类枚举取自宿主源码：${allowedCategories.length} 项，与内置兜底一致`);
    }
  }
  const reservedSrc = extractStringArray(readTextIfExists(manifestSource) ?? "", "CORE_RESERVED_PLUGIN_IDS");
  if (reservedSrc && reservedSrc.length > 0) {
    reservedIds = reservedSrc;
  }
} else {
  notes.push(`未找到宿主源码（${categoriesSource}），使用内置兜底列表校验`);
}

// ---------- 清单本身 ----------
const manifestPath = join(root, "openclaw.plugin.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`✗ 读不到或无法解析 openclaw.plugin.json：${error.message}`);
  process.exit(1);
}

// 1. id
if (typeof manifest.id !== "string" || manifest.id.trim() === "") {
  problems.push("缺少必需的 id");
} else if (reservedIds.includes(manifest.id)) {
  problems.push(`id "${manifest.id}" 被核心保留（当前保留列表：${reservedIds.join(", ")}）`);
}

// 2. configSchema
if (typeof manifest.configSchema !== "object" || manifest.configSchema === null || Array.isArray(manifest.configSchema)) {
  problems.push("缺少必需的 configSchema（必须是对象；可以是空 schema 占位）");
}

// 3. categories
if (manifest.categories !== undefined) {
  const categories = manifest.categories;
  if (!Array.isArray(categories)) {
    problems.push("categories 必须是数组");
  } else if (categories.length < 1 || categories.length > 3) {
    problems.push(`categories 必须含 1~3 项，当前 ${categories.length} 项`);
  } else {
    for (const entry of categories) {
      if (!allowedCategories.includes(entry)) {
        problems.push(
          `categories 含未知取值 ${JSON.stringify(entry)}（宿主枚举：${allowedCategories.join(", ")}）`,
        );
      }
    }
    if (new Set(categories).size !== categories.length) {
      problems.push("categories 不得重复");
    }
  }
}

// 4. channels ⊆ channelConfigs
const channels = Array.isArray(manifest.channels) ? manifest.channels : [];
const channelConfigKeys = Object.keys(manifest.channelConfigs ?? {});
const missingConfigs = channels.filter((id) => !channelConfigKeys.includes(id));
if (missingConfigs.length > 0) {
  problems.push(
    `channels 里声明了 ${missingConfigs.join(", ")} 但 channelConfigs 里没有对应条目（不阻断加载，但配置 schema / setup UI 会缺）`,
  );
}

// ---------- 输出 ----------
for (const note of notes) {
  console.log(`· ${note}`);
}
if (problems.length === 0) {
  console.log(`✓ openclaw.plugin.json 通过校验（id=${manifest.id}，categories=${JSON.stringify(manifest.categories ?? [])}）`);
  process.exit(0);
}
console.error(`✗ openclaw.plugin.json 有 ${problems.length} 个问题：\n`);
for (const problem of problems) {
  console.error(`    - ${problem}`);
}
console.error(
  "\n  注：这些是宿主清单校验的**硬失败**分支，会导致 `plugins install` 在 npm install 之后以 EXIT=1 结束。",
);
process.exit(1);
