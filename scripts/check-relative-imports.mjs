#!/usr/bin/env node
/**
 * 相对 import 悬空检查。
 *
 * 为什么单独做这一步：本仓库是从旧插件骨架改写来的，最容易犯、也最**静默**的错误是
 * **import 了一个不存在（或已被删除）的相对模块** —— 例如骨架里引用了旧协议文件 legacy-ok
 * （旧协议名的具体清单见 `check-no-legacy-refs.mjs`），而这些文件在改写时被删掉了。
 * 纯逻辑层的单测**发现不了**这种问题（那些文件根本不参与纯逻辑编译），
 * 只有插件真被加载时才炸。
 *
 * 本脚本把每个相对 import 解析到磁盘，检查目标文件是否存在（`.js` 后缀会尝试映射到 `.ts`，
 * 因为本仓库是 TS + NodeNext）。
 *
 * 用法：node scripts/check-relative-imports.mjs
 * 退出码：0 = 全部可解析，1 = 有悬空引用。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-pure", ".git"]);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collect(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** `./x.js` → 依次尝试 x.ts / x.js / x/index.ts */
function resolveSpecifier(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base];
  if (base.endsWith(".js")) {
    candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  }
  candidates.push(join(base, "index.ts"), join(base, "index.js"));
  return candidates.some((candidate) => existsSync(candidate));
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;

const dangling = [];
for (const file of collect(root)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? "";
    if (!specifier.startsWith(".")) {
      continue; // 裸模块名（openclaw/plugin-sdk/*、node:*、zod）交由 verify:sdk / 包管理器判定
    }
    if (!resolveSpecifier(file, specifier)) {
      dangling.push({ file: file.slice(root.length + 1), specifier });
    }
  }
}

if (dangling.length === 0) {
  console.log("✓ 所有相对 import 都能解析到实际文件");
  process.exit(0);
}

console.error(`✗ 发现 ${dangling.length} 处悬空 import：\n`);
for (const item of dangling) {
  console.error(`  ${item.file}  →  ${item.specifier}`);
}
process.exit(1);
