#!/usr/bin/env node
/**
 * SDK 符号存在性检查。
 *
 * 目的：本插件的部分文件依赖 `openclaw/plugin-sdk/*`，而 openclaw 本体没有装进
 * 本仓库（体积太大）。在没有 `node_modules/openclaw` 的情况下，`tsc` 无法类型检查
 * 这些文件，**但最容易犯的错其实只有两类**：
 *   ① 子路径写错（`openclaw/plugin-sdk/xxx` 不存在）
 *   ② 符号名写错（SDK 里没有这个导出）
 * 本脚本对着本地 openclaw 仓库的源码逐条核对这两件事，不需要安装任何依赖。
 *
 * 用法：
 *   node scripts/verify-sdk-symbols.mjs [--openclaw=<openclaw 仓库路径>]
 * 默认按同级目录 ../openclaw 查找。
 *
 * 退出码：0 = 全部通过，1 = 有找不到的子路径或符号。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "..");

const argOpenclaw = process.argv.find((a) => a.startsWith("--openclaw="));
const openclawRoot = argOpenclaw
  ? resolve(argOpenclaw.slice("--openclaw=".length))
  : resolve(pluginRoot, "..", "openclaw");

if (!existsSync(openclawRoot)) {
  console.error(`✗ 找不到 openclaw 仓库: ${openclawRoot}\n  用 --openclaw=<path> 指定。`);
  process.exit(1);
}

const sdkExportMapPath = join(openclawRoot, "package.json");
const sdkSourceDir = join(openclawRoot, "src/plugin-sdk");

/**
 * 注意：SDK 有两个 package.json，别查错：
 *   - `<openclaw>/package.json`            ← 根包，`openclaw/plugin-sdk/*` 的真正解析目标（外部插件用这个）
 *   - `<openclaw>/packages/plugin-sdk/package.json` ← 独立的 SDK 包，**不含** channel-* 子路径
 * 早期版本的本脚本查了后者，导致 10 个合法子路径被误报为不存在。
 */

/** 递归收集插件自身的 .ts 文件 */
function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "dist-pure") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 抽取 import/export { A, B as C } from "openclaw/plugin-sdk/<sub>" */
function extractSdkImports(filePath) {
  const source = readFileSync(filePath, "utf8");
  const results = [];
  // 同时覆盖 `import {...} from` 与 `export {...} from`（后者是纯导出面，容易漏检）
  const re =
    /(?:import|export)\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'](openclaw\/plugin-sdk\/[^"']+)["']/g;
  for (const match of source.matchAll(re)) {
    const rawNames = match[1];
    const subpath = match[2];
    const symbols = rawNames
      .split(",")
      .map((piece) => piece.trim())
      .filter(Boolean)
      // 处理 `X as Y`
      .map((piece) => piece.split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    results.push({ subpath, symbols });
  }
  return results;
}

/** 从根 openclaw 包的 exports 映射里解析子路径 → 源码文件 */
function resolveSubpath(subpath, exportMap) {
  const short = subpath.replace("openclaw/plugin-sdk/", "");
  const key = `./plugin-sdk/${short}`;
  const entry = exportMap[key];
  if (!entry) {
    return undefined;
  }

  // 优先用源码（本机 openclaw 未构建，dist/*.d.ts 不存在）
  const source = join(sdkSourceDir, `${short}.ts`);
  if (existsSync(source)) {
    return source;
  }

  // 退而求其次：exports 指向的产物文件
  const target = typeof entry === "string" ? entry : entry.types ?? entry.default;
  if (typeof target === "string") {
    const candidate = resolve(openclawRoot, target);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** 收集"该文件直接或间接 re-export 出来的源码"，用于跨文件查找符号 */
function reExportTargets(filePath, depth = 0, seen = new Set()) {
  const files = [filePath];
  if (depth > 2 || seen.has(filePath)) {
    return files;
  }
  seen.add(filePath);
  const source = readFileSync(filePath, "utf8");
  const re = /export\s+(?:type\s+)?\{[^}]*\}\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(re)) {
    const spec = match[1];
    if (!spec.startsWith(".")) {
      continue;
    }
    const base = resolve(dirname(filePath), spec);
    for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        files.push(...reExportTargets(candidate, depth + 1, seen));
        break;
      }
    }
  }
  return files;
}

/** 判断 symbol 是否真的被导出（启发式：在 export 语句里出现） */
function isExported(symbol, files) {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    // export function X / export const X / export class X / export interface X / export type X / export enum X
    new RegExp(`export\\s+(?:declare\\s+)?(?:type\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${escaped}\\b`),
    // export { X } / export { X, Y } / export type { X }
    new RegExp(`export\\s+(?:type\\s+)?\\{[^}]*\\b${escaped}\\b[^}]*\\}`, "s"),
  ];
  return files.some((file) => {
    const source = readFileSync(file, "utf8");
    return patterns.some((pattern) => pattern.test(source));
  });
}

function main() {
  const exportMap = JSON.parse(readFileSync(sdkExportMapPath, "utf8")).exports ?? {};
  const files = collectSourceFiles(pluginRoot);

  const bySubpath = new Map();
  for (const file of files) {
    for (const { subpath, symbols } of extractSdkImports(file)) {
      const entry = bySubpath.get(subpath) ?? { symbols: new Set(), files: new Set() };
      for (const symbol of symbols) {
        entry.symbols.add(symbol);
      }
      entry.files.add(file.replace(pluginRoot, ".").replaceAll("\\", "/"));
      bySubpath.set(subpath, entry);
    }
  }

  let failures = 0;
  console.log(`检查 ${bySubpath.size} 个 SDK 子路径（openclaw: ${openclawRoot}）\n`);

  for (const [subpath, entry] of [...bySubpath].sort()) {
    const resolved = resolveSubpath(subpath, exportMap);
    if (!resolved) {
      failures += 1;
      console.log(`✗ ${subpath}\n    子路径在 packages/plugin-sdk/package.json 的 exports 里不存在`);
      continue;
    }
    const searchFiles = reExportTargets(resolved);
    const missing = [...entry.symbols].filter((symbol) => !isExported(symbol, searchFiles));
    if (missing.length > 0) {
      failures += missing.length;
      console.log(`✗ ${subpath}  (${resolved.replace(openclawRoot, "<openclaw>")})`);
      console.log(`    找不到导出: ${missing.join(", ")}`);
      console.log(`    引用位置: ${[...entry.files].join(", ")}`);
    } else {
      console.log(`✓ ${subpath} — ${[...entry.symbols].sort().join(", ")}`);
    }
  }

  console.log(
    failures === 0
      ? "\n结论: 全部通过 ✅（所有子路径与符号都能在本地 openclaw 源码里找到）"
      : `\n结论: ${failures} 处不匹配 ❌`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
