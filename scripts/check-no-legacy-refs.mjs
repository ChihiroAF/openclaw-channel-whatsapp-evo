#!/usr/bin/env node
/**
 * 旧方案残留检查（Meta Cloud API / whatsapp-cloud 时代）。
 *
 * 背景：本仓库是从旧插件 `openclaw-channel-whatsapp-cloud` 的骨架上改写而来。
 * 骨架复用的风险不是"能不能跑"，而是**新旧代码混在一起**：旧标识（渠道 id、Meta 凭证字段名、
 * 已删除的模块引用）散落在没改到的文件里，既不报错也很难发现，直到装到实例上才炸。
 *
 * 这个脚本把"改干净了没有"变成一个可执行的判据：只要还有旧标识就红。
 * 它同时是"骨架改写完成"的验收标准 —— 全绿就说明仓库里只剩 EVO 一条链路。
 *
 * 用法：
 *   node scripts/check-no-legacy-refs.mjs
 * 退出码：0 = 干净，1 = 仍有残留。
 *
 * 若某处**刻意**要提到旧名字（例如测试里模拟"配错了渠道段"），在该行加注释 `legacy-ok` 即可放行。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** 每条规则：{ 描述, 正则 } —— 命中即视为旧方案残留 */
const RULES = [
  { what: "旧渠道 id / 旧类名", re: /whatsapp-cloud|WhatsAppCloud|WHATSAPP_CLOUD/ },
  { what: "旧模块引用（已删除）", re: /graph-client|GraphClient|WamidDedupe|dedupe\.js|\.\/webhook\.js|sendWhatsAppCloudText|normalizeWhatsAppCloudTarget|InboundMessage/ },
  { what: "Meta Cloud API 的凭证字段", re: /phoneNumberId|wabaId|accessToken|appSecret|verifyToken|graphApiVersion|sendReadReceipt|sendTypingIndicator/ },
  { what: "已作废的文档引用", re: /AvatarClaw-WABA-开发计划文档|AvatarClaw-WABA-需求文档\.md/ },
];

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-pure", ".git"]);
/** 扫描器自己就是"旧名字的字典"，不自我扫描 */
const SKIP_FILES = new Set(["scripts/check-no-legacy-refs.mjs"]);
const SCAN_EXT = [".ts", ".json", ".md", ".mjs"];

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (
      SCAN_EXT.some((ext) => entry.endsWith(ext)) &&
      entry !== "package-lock.json" &&
      !SKIP_FILES.has(full.slice(root.length + 1).replace(/\\/g, "/"))
    ) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
for (const file of collect(root)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes("legacy-ok")) {
      return;
    }
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        findings.push({
          file: file.slice(root.length + 1),
          line: index + 1,
          what: rule.what,
          text: line.trim().slice(0, 120),
        });
        break;
      }
    }
  });
}

if (findings.length === 0) {
  console.log("✓ 无旧方案残留（仓库里只剩 EVO 一条链路）");
  process.exit(0);
}

const byFile = new Map();
for (const finding of findings) {
  const list = byFile.get(finding.file) ?? [];
  list.push(finding);
  byFile.set(finding.file, list);
}

console.error(`✗ 发现 ${findings.length} 处旧方案残留，分布在 ${byFile.size} 个文件：\n`);
for (const [file, list] of [...byFile.entries()].sort()) {
  console.error(`  ${file}  (${list.length})`);
  for (const item of list.slice(0, 3)) {
    console.error(`      ${item.line}: [${item.what}] ${item.text}`);
  }
  if (list.length > 3) {
    console.error(`      …另有 ${list.length - 3} 处`);
  }
}
console.error("\n（刻意保留的旧名字请在该行加注释 legacy-ok）");
process.exit(1);
