# Changelog

本文件记录本插件的所有重要变更。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

后续开发的新功能在此累积，**不影响已发布的稳定版本**。
需要长期跑在某个稳定点上的实例，请按下方「安装方式」锁定 tag 安装。

---

## [0.2.0] - 2026-09-24

**当前稳定可用版本。** 经 UAT 端到端联调验证：入站回调 → agent 应答 → 出站送达全链路正常。

### 修复

- **插件清单的分类枚举**：`openclaw.plugin.json` 的 `categories` 之前用了宿主不认的值，
  导致插件"装上去但不加载"，且只在实例日志里留一条 warn 级别的提示，很难察觉。
  现改为合法的 `["channels"]`，并新增 `verify:manifest` 脚本从宿主源码反查枚举，防止再次写错。
- **移除 `zod` 依赖**：该依赖并非必需，却会拖累实例内的安装过程。
  移除后 `package-lock.json` 只剩 3 个 `resolved`，全部指向公共 registry。
- **lockfile registry 规范化**：原先 lockfile 里混入了内网 registry 主机名，
  在实例内 `npm install` 会报 `EALLOWREMOTE`，同时把内网域名泄漏到公开仓库。
  现统一为 `https://registry.npmjs.org`，并新增 `verify:lockfile` 门禁。
- **`config-schema` 的过期导出**：修正了一处失效的模块导出，
  并新增 `verify:exports` 脚本校验全部 94 处相对具名导入。

### 新增

- `verify:sdk` —— 校验用到的 `openclaw/plugin-sdk/*` 子路径与符号在宿主源码中真实存在。
- `verify:manifest` —— 校验插件清单的分类枚举与宿主一致。
- `verify:exports` —— 校验相对模块的具名导入都能找到对应导出。
- `verify:legacy` —— 确认仓库内无旧方案（Meta Cloud API）残留。
- `verify:imports` —— 确认所有相对 import 都能解析到实际文件。
- `verify:lockfile` —— 确认 lockfile 的 `resolved` 只指向公共 registry。
- `npm run verify` —— 上述 6 项的一次性聚合入口。
- `src/__tests__/manifest-parity.test.ts` —— 清单与 schema 的一致性测试。
- CI 工作流新增 **dist 新鲜度检查**：`dist/` 是刻意入库的编译产物（Git 方式安装的插件
  必须自带），忘记 `npm run build` 就提交的后果是"插件不加载"，该检查用于兜住这类静默故障。

### 说明

本次变更集中在**"能被正确安装与加载"**上，不涉及业务逻辑改动，
因此既有渠道行为保持不变，可平滑替换。

---

## [0.1.0] - 2026-09-22

首个版本。

### 新增

- WhatsApp 渠道插件（经 EVO 平台 / Evolution API 接入）。
- 接收 EVO 标准化后的入站消息，交由 agent 运行时处理，
  再经 EVO 把回复发回客户。
- 插件结构：`index.ts` / `api.ts` / `runtime-api.ts` / `setup-entry.ts` + `src/`。

### 设计要点

- **Meta 凭证不经过本插件也不经过 controller**：验签、去重、标准化与凭证保管全部由 EVO 负责，
  本插件只处理 EVO 已经标准化的报文。
- 出站走 EVO 的发送接口，回复链路的最终投递由 EVO 完成。

---

## 安装方式

### 方式一：跟随最新（开发环境）

```bash
# 安装 main 分支最新代码
openclaw plugins install git+https://github.com/ChihiroAF/openclaw-channel-whatsapp-evo.git
```

### 方式二：锁定稳定版本（推荐用于联调与生产）

```bash
# 锁定到某个 tag，后续 main 上的开发不会影响该实例
openclaw plugins install git+https://github.com/ChihiroAF/openclaw-channel-whatsapp-evo.git#v0.2.0
```

> ⚠️ `dist/` 是入库的编译产物。若从源码目录直接安装而非走 git，
> 请先执行 `npm run build` 再安装，否则插件不会加载。

---

## 维护备忘

发布新版本前请依次执行，全绿再打 tag：

```bash
npm run build      # 重新编译 dist（必须，且结果需与入库版本一致）
npm run verify     # 6 项门禁
npm test           # 纯逻辑层单测
git status --porcelain   # 应无输出，确认 dist 已是最新且无遗留改动
```

然后更新本文件的 `[Unreleased]` 区块，改 `package.json` 版本号，再打 tag。

[Unreleased]: https://github.com/ChihiroAF/openclaw-channel-whatsapp-evo/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ChihiroAF/openclaw-channel-whatsapp-evo/releases/tag/v0.2.0
[0.1.0]: https://github.com/ChihiroAF/openclaw-channel-whatsapp-evo/releases/tag/v0.1.0
