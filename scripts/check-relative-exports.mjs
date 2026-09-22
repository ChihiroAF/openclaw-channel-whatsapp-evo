/**
 * 闸门：**相对模块的具名导入必须真的被导出**。
 *
 * 为什么需要它（2026-09-22 真实事故，代价是一次实例创建 + 一轮联调）：
 * 把 `config-fields.ts` 的导出从 `evoChannelConfigSchema` 改名成 `parseEvoChannelConfig` 时，
 * `config-schema.ts` 还在 import 旧名字。结果：
 *   - `npm test` **绿**：`tsconfig.pure.json` 不包含 `config-schema.ts`（它 import SDK）
 *   - `npm run build` **绿**：构建用 `--noCheck`，tsc 不做类型检查，照样 emit 出坏 import
 *   - `verify:imports` **绿**：那个脚本只检查**模块路径**能否解析，不看导出名
 * 于是坏代码一路进了 dist 并被提交。直到容器里加载才炸：
 *   [plugins] whatsapp-evo failed to load from …/repo/dist/index.js:
 *   SyntaxError: The requested module './config-fields.js' does not provide an export named
 *   'evoChannelConfigSchema'
 *
 * 这个错误在 ESM 下是**加载期**异常，且运行时才暴露 —— 纯静态检查就能拦住，成本极低。
 *
 * 覆盖：
 *   - `import { a, b as c } from "./x.js"`  → a、b 必须被 `x.ts` 导出
 *   - `import type { T } from "./x.js"`     → 同上（类型也算导出）
 *   - `import d from "./x.js"`              → `x.ts` 必须有 default 导出
 *   - 目标是 `export * from`（星号重导出）时无法静态判定 ⇒ 跳过该目标并提示（不误报）
 *   - 命名空间导入 `import * as ns`         → 动态访问，天然跳过
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-pure", ".git"]);

function collectTsFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsFiles(full, out);
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** `./x.js` / `../y/index.js` → 实际存在的 .ts 文件；找不到返回 null */
function resolveRelativeModule(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

/** 收集某文件的导出名 + 是否有 default / 星号重导出 */
function collectExports(filePath) {
  const source = readFileSync(filePath, "utf8");
  const names = new Set();
  let hasDefault = false;
  let hasStarReExport = false;

  for (const match of source.matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
  )) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const piece of match[1].split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) {
        continue;
      }
      // `A as B` 里对外可见的是 B
      const parts = trimmed.split(/\s+as\s+/);
      names.add((parts[1] ?? parts[0]).trim());
    }
  }
  if (/export\s+default\b/.test(source)) {
    hasDefault = true;
  }
  if (/export\s+\*\s+from/.test(source)) {
    hasStarReExport = true;
  }
  return { names, hasDefault, hasStarReExport };
}

const problems = [];
const skipped = [];
let checked = 0;

for (const file of collectTsFiles(root)) {
  const source = readFileSync(file, "utf8");
  const relativeFile = relative(root, file).replaceAll("\\", "/");

  // import { ... } from "./x.js"  /  import type { ... } from "./x.js"
  for (const match of source.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](\.[^"']*)["']/g,
  )) {
    const specifier = match[2];
    const target = resolveRelativeModule(file, specifier);
    if (!target) {
      continue; // 路径不存在由 verify:imports 负责报
    }
    const { names, hasStarReExport } = collectExports(target);
    if (hasStarReExport) {
      skipped.push(`${relativeFile} → ${specifier}（含 export *，无法静态判定）`);
      continue;
    }
    for (const piece of match[1].split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) {
        continue;
      }
      // 注意两种写法都要处理：
      //   `import type { A } from`        —— type 在花括号外
      //   `import { type A, B } from`    —— type 是花括号内的**内联修饰符**（容易漏，会误报）
      // 取 A 时先剥掉内联 `type`，再处理 `A as B`（本地名是后者，被导出的仍是前者）。
      const withoutInlineType = trimmed.replace(/^type\s+/, "");
      const imported = withoutInlineType.split(/\s+as\s+/)[0].trim();
      if (!imported) {
        continue;
      }
      checked += 1;
      if (!names.has(imported)) {
        problems.push(
          `${relativeFile}\n      import { ${trimmed} } from "${specifier}"\n      → ${relative(
            root,
            target,
          ).replaceAll("\\", "/")} 没有导出 ${imported}`,
        );
      }
    }
  }

  // import d from "./x.js"（含 `import d, { ... } from`）
  for (const match of source.matchAll(
    /import\s+([A-Za-z0-9_$]+)\s*(?:,\s*(?:type\s+)?\{[^}]*\})?\s+from\s+["'](\.[^"']*)["']/g,
  )) {
    const specifier = match[2];
    const target = resolveRelativeModule(file, specifier);
    if (!target) {
      continue;
    }
    const { hasDefault, hasStarReExport } = collectExports(target);
    if (hasStarReExport) {
      continue;
    }
    checked += 1;
    if (!hasDefault) {
      problems.push(
        `${relativeFile}\n      import ${match[1]} from "${specifier}"\n      → ${relative(
          root,
          target,
        ).replaceAll("\\", "/")} 没有 default 导出`,
      );
    }
  }
}

for (const note of skipped) {
  console.log(`· 跳过（无法静态判定）: ${note}`);
}

if (problems.length === 0) {
  console.log(`✓ ${checked} 处相对模块的具名导入全部能在目标模块里找到对应导出`);
  process.exit(0);
}

console.error(`✗ 发现 ${problems.length} 处悬空导出引用：\n`);
for (const problem of problems) {
  console.error(`    - ${problem}`);
}
console.error(
  [
    "",
    "  注：这是 ESM 的**加载期**错误 —— 单测与构建都可能全绿（构建用 --noCheck），",
    "      直到插件真正被加载时才炸。改导出名时务必同步所有引用。",
    "",
  ].join("\n"),
);
process.exit(1);
