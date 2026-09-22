# openclaw-channel-whatsapp-evo

OpenClaw 渠道插件 —— **WhatsApp，经 EVO 平台（Evolution API）收发**。

> 本仓库是 WABA×EVO 接入的**交付物 B**。交付物 A（绑定接口 / webhook 入口 / 状态查询）
> 在 `openclaw-controller` 仓库。完整契约见
> `openclaw-controller/docs/AvatarClaw-WABA-EVO-开发文档.md` 与
> `openclaw-controller/docs/AvatarClaw-WABA-EVO-需求文档-最终版.md`。

## 链路概览

```
客户 WhatsApp ── Meta ──> EVO 平台 ──(webhook)──> controller ──(原样转发)──> 本插件
                                                                              │
                                                                     派发给 openclaw agent
                                                                              │
客户 WhatsApp <── Meta ── EVO 平台 <──(POST /message/sendText)────────────────┘
```

**EVO 负责**：Meta 侧验签、号码识别、事件标准化、去重、Meta 出站、媒体、凭证。
**controller 负责**：claw ↔ EVO 实例映射、FROM 白名单、权限策略、会话映射、原样转发、运行日志。
**本插件负责**：解析 EVO 事件、派发给 agent、把回复发回 EVO。

## 职责边界（谁做什么）

| 环节 | 归属 | 说明 |
|---|---|---|
| EVO 事件 → 定位 claw → **原样转发** | **controller** | 转发用**原始 body 字节**，不做任何改写 |
| 事件过滤（只放行「新消息」） | **controller**（兜底） + **本插件**（冗余） | 插件侧 `payload.ts` 里再判一次，兼容 v1/v2 两种事件名写法 |
| 入站解析（号码 / 文本 / 媒体识别） | **本插件** | 全程宽松容错，异常只降级成"跳过 + 原因"，绝不抛 |
| 派发给 agent | **本插件** | 三步链路：路由 → 准入 → dispatch |
| 出站回复（`/message/sendText`） | **本插件** | 直连 EVO，不带 controller |
| `dmPolicy` / `allowFrom` 准入判定 | **openclaw 核心** | 插件**不**自己再拦一层，避免两边规则打架 |

## 配置（由 controller 在 bind 时写入实例的 `openclaw.json`）

```jsonc
{
  "channels": {
    "whatsapp-evo": {
      "evoBaseUrl": "https://ev-api.example.com", // 必填，EVO 平台基址
      "evoApiKey": "…",                            // 必填，EVO 平台 apikey（只存在实例里，不进日志）
      "evoInstanceId": "…",                        // 建议填：agent 主动发送时没有请求头可依赖
      "dmPolicy": "open",                          // ⚠️ 见下：不配 = 静默丢消息
      "allowFrom": ["*"]                           // ⚠️ 见下：光有 open 不够
    }
  }
}
```

### 🔴 准入配置漏了会**静默**丢消息

1. 核心的默认 `dmPolicy` 是 `pairing`（`src/channels/direct-dm-access.ts` 的 `dmPolicy ?? "pairing"`），
   未配对发送者会被 `block-dispatch`，**不报错**。
2. 即使写了 `dmPolicy: "open"`，核心仍要求 `allowFrom` 含通配项 `*`，
   否则落 `dm_policy_not_allowlisted`，**同样不报错**。

⇒ 必须 **`dmPolicy: "open"` ＋ `allowFrom: ["*"]` 同时具备**。
插件在账户启动时会检查这两项，不满足就打一条 WARN（见 `config-fields.ts` 的 `checkEvoAccessConfig`），
并在 status 里以 `accessWarning` 暴露。

字段名必须与 controller 写入端**逐字一致**（`internal/logic/channel/bindwabaevologic.go`）。
`src/__tests__/accounts.test.ts` 里硬编码了一份"controller 会写入的内容"做契约回归测试，改名即红。

## 安装与启用

外部插件（`plugins install`）**安装即启用**，不需要在 `openclaw.json` 里写 `plugins.entries.<id>.enabled`：

- `plugins install` 把包放到 `~/.openclaw/extensions/<name>`，发现阶段标记为 `origin: "global"`，
  而 `resolvePluginActivationDecisionShared` 对 `global` 的默认判定就是**开启**
  （`bundled` 与 `workspace` 才是默认关闭，所以内置渠道必须在 entries 里显式开——我们不需要）。
- 渠道开关的语义是「缺席 ≠ 关闭」：只有显式 `enabled: false` 才关闭。

安装（由实例的 post-start 脚本执行，**不要加 `|| true`**，失败就该让实例显式失败）：

```bash
# 开发期用分支，改完 push 即可生效；演示/发布把 ref 换成 tag 钉版本
openclaw plugins install git+https://github.com/<org>/<repo>.git#main --force
```

### ⚠️ 两个硬要求

1. **必须带 `--force`**：`clawhub:` 之外的来源（git / npm / 本地路径…）都会走交互式确认
   （`src/plugins/install-provenance.ts:14` 的 `NON_CLAWHUB_INSTALL_FORCE_FLAG`），
   而 post-start 是非交互 shell，不加会失败或挂住。
2. **必须自带编译产物**：`src/plugins/package-entry-resolution.ts:461-477` 对"已安装的包"要求
   TS 入口存在已构建的 JS 候选（`./dist/index.js` 等），否则只推一条 warn 然后 `return null`
   —— **插件不加载且不报错**。所以：

   ```bash
   npm run build        # 产出 dist/；提交 dist 或用 CI 构建后再推 tag
   ```

   > 例外：**本地路径来源不要求编译产物**（`discovery.ts:446-451`，`record.source === "path"`）。
   > 所以联调期想跳过一次构建，可以 `kubectl cp` 源码目录进容器再
   > `openclaw plugins install <容器内路径> --force`。
   >
   > `npm run build` 用 `--noCheck`：SDK 层没装 openclaw（用 `typings/` 的占位声明），
   > 对 any 化的 SDK 做类型检查只会产出假报错。真正的闸门是 `npm test` + `npm run verify`。
   > 想看 SDK 层报错用 `npm run build:checked`。

配置热加载：插件在 `reload.configPrefixes` 里声明了 `channels.whatsapp-evo`，
所以 controller 在 bind 时改写 `openclaw.json` 后，核心会 **hot reload** 本渠道
（`src/gateway/config-reload-plan.ts` 判为 `kind: "hot"`）⇒ 重新注册入站路由，**不需要重启 Pod**。
⚠️ 但**代码变更**不在热加载范围内（配置才是）：改插件代码后需要重装并重启实例进程。

## 开发与验证

```bash
npm install
npm test             # tsc -p tsconfig.pure.json && node --test
npm run verify:sdk   # 对着同级 ../openclaw 源码核对用到的 SDK 子路径与符号
npm run verify:legacy # 检查是否残留旧方案（Meta Cloud API / whatsapp-cloud）的痕迹 legacy-ok
npm run verify       # 上面两个一起跑
```

本机不安装 openclaw（体积过大且常拉不下来），所以：

- **纯逻辑层**（`constants` / `logger` / `config-fields` / `accounts` / `payload` / `evo-client` / `outbound`）
  不 import SDK，用 `tsconfig.pure.json` 离线编译 + `node --test` 单测覆盖。
- **SDK 层**（`channel*` / `gateway` / `http` / `inbound` / `status` / `runtime`）无法类型检查，
  靠 `verify:sdk` 逐条核对子路径与符号存在性兜住。

> 本仓库最初是从旧插件 `openclaw-channel-whatsapp-cloud` 的骨架改写而来。 legacy-ok
> 那次复用留下了**静默的新旧混杂**（悬空 import、旧标识散落），教训是：
> 这类"协议整体更换"的改写，**只借目录结构与配置形状，源码一律新写**。
> `npm run verify:legacy` 就是这件事的判据；刻意保留旧名字的行加注释 `legacy-ok`。

## 发布到 GitHub（实例从这里安装）

### 首次上传

```bash
cd openclaw-channel-whatsapp-evo
git init -b main
git add .
git commit -m "feat: whatsapp-evo channel plugin (v0.1.0)"
git remote add origin git@github.com:<org>/<repo>.git   # 或 https://github.com/<org>/<repo>.git
git push -u origin main
```

### 每次迭代（顺序不能少 `build`）

```bash
npm test && npm run verify     # 本地自检（verify:sdk 需要同级有 openclaw 源码）
npm run build                  # ⚠️ 必须：产出 dist/ 并一起提交
git add -A && git commit -m "..." && git push
```

然后在实例里重装（**代码变更不在热加载范围内**，配置才是）：

```bash
openclaw plugins install git+https://github.com/<org>/<repo>.git#main --force
```

演示/发布时把 `#main` 换成 tag：`git tag v0.1.0 && git push --tags` → `…#v0.1.0`。

### 必须提交 / 必须忽略

| 提交 ✅ | 忽略 ⛔ |
|---|---|
| 源码：`index.ts` / `setup-entry.ts` / `api.ts` / `runtime-api.ts` / `src/**` | `node_modules/` |
| **`dist/`（构建产物，故意提交）** | `dist-pure/`（单测用构建输出） |
| `typings/`（SDK 占位声明，`npm run build` 需要） | `*.tgz`（`npm pack` 产物） |
| `scripts/`（三个校验脚本） | `*.log` / `coverage/` / `.env*` |
| `openclaw.plugin.json` / `package.json` / `package-lock.json` | `.DS_Store` / `Thumbs.db` / `.idea/` / `.vscode/` |
| `tsconfig*.json` / `README.md` / `.github/` | — |

> **为什么 `dist/` 要提交**：实例是从 Git 直接安装的，没有构建步骤，而 openclaw 要求
> 已安装的包自带已构建的 JS 入口（见上文「两个硬要求」）。忘记构建就 push 的后果是
> **插件不加载且只有一条 warn 日志**，所以 `.github/workflows/ci.yml` 里有一条
> "dist 是否与源码一致"的检查兜住它。
>
> **本仓库不含任何凭证**：EVO 的 `evoBaseUrl` / `evoApiKey` 由 controller 在 bind 时写入
> 实例的 `openclaw.json`，不进代码库。

## 以后发布到 ClawHub（v1 不做，记着这条路是通的）

`clawhub:` 是**唯一受信任、无需 `--force`** 的来源，所以将来上架后安装命令会简化为
`openclaw plugins install clawhub:<slug>`。

⚠️ **上架时有一个必须对齐的字段**：ClawHub 侧声明的 **runtime / plugin id 必须等于本仓库
`openclaw.plugin.json` 的 `id`（`whatsapp-evo`）**。安装时 `install-installed-package.ts:97-110`
会做一次硬校验：`expectedPluginId`（ClawHub 提供）≠ `pluginId` 就报
`plugin id mismatch: expected X, got Y`；而这条**只在 ClawHub 路径**上会触发
（git / npm / 本地路径都不设 `expectedPluginId`，所以现在不受影响）。

顺带澄清一个容易误传的规则：**npm 包名与 manifest id 不一致不是错误**，只是一条 INFO 日志
（`install-installed-package.ts:112-116`：`… differs from npm package name …; using manifest id as the config key`）。
本仓库是刻意对齐的——包名后缀、manifest id、channel id 都是 `whatsapp-evo`，所以这条日志也不会出现。

### 命名规则（避免"一个东西两个名字"）

| 词 | 用在哪 |
|---|---|
| **`whatsapp-evo`** | 渠道标识：channel id、`openclaw.plugin.json` 的 `id`、配置键 `channels.whatsapp-evo`、controller 渠道路由 `/channels/whatsapp-evo/*`、**本仓库名/包名后缀**、插件内部入站路由 `/whatsapp-evo/webhook` |
| **`waba`** | 仅作**功能命名空间**：controller 对 EVO 的公开回调路径 `/api/v1/waba/webhook/{instanceId}`、项目文档文件名 `AvatarClaw-WABA-EVO-*.md` |

⇒ **本仓库不出现 `waba-evo`**（那是两者混出来的第三个词）。

## v1 范围与已知取舍

- ✅ 文本消息双向打通。
- ⛔ **媒体（图片/语音/文件等）不投递**：只记一条 INFO 日志并丢弃。
- ⛔ **无入站鉴权**（路由 `auth: "plugin"`，v1 不做不可猜 token / IP 白名单）。
- ⛔ **不做 wamid 去重**（依赖 EVO 侧去重）。
- ⛔ 群消息（`@g.us`）与广播消息（`@broadcast`）直接丢弃。

以上都是为按期交付**主动接受的债**，详见需求文档 §7.2；v2 清单见开发文档 §8。
