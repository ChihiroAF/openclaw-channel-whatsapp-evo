/**
 * 闸门：`package-lock.json` 里**不允许出现公共 registry 之外的 tarball 主机**。
 *
 * 为什么需要这个脚本（2026-09-22 实测踩坑，两个后果都很贵）：
 *
 * 1. **可移植性 / 装得上**：
 *    插件是通过 `openclaw plugins install git:…` 装的，该路径会在 git clone 之后跑一次
 *    `npm install --omit=dev`（`src/plugins/git-install.ts:447-468`）。npm 12 起
 *    `allow-remote` 默认从 `all` 改为 `none`，只放行"与该环境配置的 registry **同源且路径前缀匹配**"
 *    的 `resolved`；lockfile 里指向**别的** registry 的绝对 URL 会被判成 `type=remote` 直接拒装：
 *      npm error code EALLOWREMOTE
 *      npm error Refusing to fetch "zod@https://<内网 registry>/…/zod-4.6.5.tgz"
 *    而写成 `https://registry.npmjs.org/…` 时，npm 的 `replace-registry-host`（默认 `npmjs`）
 *    会把它改写成**目标环境自己的** registry ⇒ 两边都成立。
 *
 * 2. **信息披露**：内网 registry 主机名不该出现在公开仓库里。
 *
 * ⚠️ 另外：**这份 lockfile 不能删**。实测（冷缓存 + registry 指向死端口）：
 *    - 有 lockfile + `--omit=dev` ⇒ 退出码 0，一个字节都不下载（完全离线可装）
 *    - 没有 lockfile + `--omit=dev` ⇒ 报 E502，npm 仍要联网解析 devDependencies 的元数据
 *    ⇒ lockfile 是"实例里不联网也能装"的前提条件。
 *
 * 正确做法：在开发机生成后把内网前缀替换为 `https://registry.npmjs.org/`，再提交。
 * 本脚本就是防止有人把带内网 host 的版本提上去。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "package-lock.json");

/** 唯一允许出现的 registry 主机 */
const ALLOWED_REGISTRY_ORIGIN = "https://registry.npmjs.org";

let parsed;
try {
  parsed = JSON.parse(readFileSync(lockPath, "utf8"));
} catch (error) {
  console.error(`✗ 读不到或无法解析 package-lock.json：${error.message}`);
  console.error("  ⚠️ 这份 lockfile 不可删除——它是实例里 `npm install` 能离线完成的前提（见脚本头注释）。");
  process.exit(1);
}

/** 收集所有 `resolved` 值（lockfile v2/v3 的 packages + 旧版 dependencies 两种形状都扫） */
function collectResolved(node, out) {
  if (node === null || typeof node !== "object") {
    return;
  }
  if (typeof node.resolved === "string") {
    out.push(node.resolved);
  }
  for (const value of Object.values(node)) {
    if (value !== null && typeof value === "object") {
      collectResolved(value, out);
    }
  }
}

const resolvedValues = [];
collectResolved(parsed.packages ?? {}, resolvedValues);
if (resolvedValues.length === 0) {
  // 空 lockfile（零依赖）也算合法：此时 install 什么都不做
  console.log("✓ package-lock.json 里没有任何 resolved 条目（零依赖，install 无需联网）");
  process.exit(0);
}

const offenders = [];
for (const resolved of resolvedValues) {
  if (resolved.startsWith(`${ALLOWED_REGISTRY_ORIGIN}/`)) {
    continue;
  }
  offenders.push(resolved);
}

if (offenders.length === 0) {
  console.log(`✓ package-lock.json 的 ${resolvedValues.length} 个 resolved 全部指向 ${ALLOWED_REGISTRY_ORIGIN}`);
  process.exit(0);
}

console.error(`✗ package-lock.json 里有 ${offenders.length} 个 resolved 指向了公共 registry 之外的主机：\n`);
for (const offender of offenders.slice(0, 20)) {
  console.error(`    ${offender}`);
}
if (offenders.length > 20) {
  console.error(`    …（其余 ${offenders.length - 20} 条略）`);
}
console.error(
  [
    "",
    "  原因：开发机的 npm registry 常被配成内网镜像（如 Nexus / Artifactory），",
    "        npm 会把绝对 tarball URL 冻进 resolved。提交这种 lockfile 会产生两个后果：",
    "        ① 内网主机名泄漏到公开仓库；",
    "        ② 实例里 `npm install` 报 EALLOWREMOTE（npm 12 的 allow-remote 闸门按同源判定）。",
    "",
    `  修法：把内网前缀整段替换为 ${ALLOWED_REGISTRY_ORIGIN}/ ，再提交。`,
    "        （npm 的 replace-registry-host 会在安装时自动改写成目标环境自己的 registry）",
    "",
  ].join("\n"),
);
process.exit(1);
