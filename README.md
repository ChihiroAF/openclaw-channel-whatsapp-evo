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
openclaw plugins install git:github.com/ChihiroAF/openclaw-channel-whatsapp-evo@main \
  --force --accept-capabilities
```

> ⚠️ **spec 前缀是 `git:`，不是 `git+https://`**。这两者**不通用**，写错会极其误导：
> `resolvePluginInstallSourcePlan` 用 `raw.trim().startsWith("git:")` 判定是否走 git 安装器
> （`src/plugins/install-source-plan.ts:134-151`；已构建产物里的报错文案是
> `Use openclaw plugins install git:<repo>@<ref>`）。`git+https://…` 不满足前缀 ⇒ 落到 npm 通道 ⇒
> 被 `npm-registry-spec.ts:69-77` 的 URL/git-ref 检查拒掉，报
> `unsupported npm spec: URLs are not allowed` —— 而日志上却显示
> `WARNING - Installing plugin from npm registry`，很容易让人以为是网络或权限问题。
> 支持的写法：`git:<owner>/<repo>@<ref>`、`git:github.com/<owner>/<repo>@<ref>`、
> `git:https://github.com/<owner>/<repo>.git@<ref>`、`git:https://…/<repo>.git#<ref>`。

### ⚠️ 四个硬要求

1. **必须带 `--force`**：`clawhub:` 之外的来源（git / npm / 本地路径…）都会走交互式确认
   （`src/plugins/install-provenance.ts:14` 的 `NON_CLAWHUB_INSTALL_FORCE_FLAG`），
   而 post-start 是非交互 shell，不加会失败或挂住。
2. **必须带 `--accept-capabilities`**：第三方插件安装要过能力确认闸门
   （`src/plugins/capability-consent.ts:262-292`：非官方来源、且插件处于启用态 ⇒ 必须有确认，
   否则抛 `requires capability consent`）。非交互 shell 里没有 TTY 可以应答，只会直接失败。
   这条与 ClawHub 上的 `zetrix-agentic-wallet` 完全同源，所以那行也带着它。
3. **本包必须保持零运行时依赖**：git 安装会在克隆后跑一次 `npm install --omit=dev`
   （`src/plugins/git-install.ts:447-468`），而 npm 12 起 `allow-remote` 默认是 `none`
   （只放行"与本环境 registry 同源"的 `resolved`）⇒ 一旦有运行时依赖，实例就必须能下载它。
   现在校验逻辑是手写的（`src/config-fields.ts`），**不依赖 zod**，所以那一步不下载任何包。
4. **必须自带编译产物**：`src/plugins/package-entry-resolution.ts:461-477` 对"已安装的包"要求
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

### 安装失败时怎么定位

| 报错 | 真实原因 | 处理 |
|---|---|---|
| `unsupported npm spec: URLs are not allowed`（前面还有 `WARNING - Installing plugin from npm registry`） | **spec 前缀写成了 `git+https://`**，不满足 `startsWith("git:")`，被当成 npm spec 拒掉。**不是网络/权限问题** | 改成 `git:…` 形式 |
| `Plugin "whatsapp-evo" requires capability consent` | 少了 `--accept-capabilities` | 补上 |
| `Install cancelled; rerun with --force` | 少了 `--force`（非交互 shell 无法应答确认） | 补上 |
| 装完 `openclaw plugins list` 里没有它 | 多为**缺编译产物**（`dist/` 没提交） | `npm run build` 后重新提交、重装 |
| `npm error code EALLOWREMOTE` / `Refusing to fetch "<pkg>@https://<某 registry>/…"` | lockfile 的 `resolved` 指向了**与本环境 registry 不同源**的主机。npm 12 起 `allow-remote` 默认 `none`，只豁免同源（且路径前缀匹配）的注册表 tarball | 把 `resolved` 里内网前缀整段换成 `https://registry.npmjs.org/`，再 `npm run verify:lockfile` |
| `npm install failed: …`（其它网络类错误） | 实例访问不到 npm registry；本包零运行时依赖，正常不该发生 | 见下方换源写法 |
| `Reason: config changed since last load` | 安装期间 `openclaw.json` 被改动（该 CLI 用延迟提交事务） | 确保 `plugins install` 前后**不要**改 `openclaw.json`；本插件自己不写配置，正常不会触发 |

### ⚠️ `package-lock.json`：必须提交，且 `resolved` 必须规范化

两条都是实测出来的，缺一个就会在实例里装不上：

- **不能删**。冷缓存实验（registry 指向死端口）：
  - 有 lockfile + `--omit=dev` ⇒ **exit 0，一个字节都不下载**（完全离线可装）
  - 没有 lockfile + `--omit=dev` ⇒ **exit 1**，npm 仍要联网解析 devDependencies 的元数据
- **不能带内网 host**。开发机的 npm registry 常被配成内网镜像，npm 会把绝对 tarball URL 冻进
  `resolved` ⇒ ①内网主机名泄漏到公开仓库；②实例上报 `EALLOWREMOTE`。

提交前处理（一行）：把内网 registry 前缀整段替换为 `https://registry.npmjs.org/`。
npm 的 `replace-registry-host`（默认 `npmjs`）会在安装时把它改写成**目标环境自己的** registry，
所以两边都成立。`npm run verify:lockfile`（已并入 `npm run verify`）会守住这条。

配置热加载：插件在 `reload.configPrefixes` 里声明了 `channels.whatsapp-evo`，
所以 controller 在 bind 时改写 `openclaw.json` 后，核心会 **hot reload** 本渠道
（`src/gateway/config-reload-plan.ts` 判为 `kind: "hot"`）⇒ 重新注册入站路由，**不需要重启 Pod**。
⚠️ 但**代码变更**不在热加载范围内（配置才是）：改插件代码后需要重装并重启实例进程。

## 开发与验证

```bash
npm install

npm test              # 纯逻辑层：tsc -p tsconfig.pure.json（strict）+ node --test
npm run verify        # 四道闸门合跑：
#   verify:sdk      对着同级 ../openclaw 源码核对用到的 SDK 子路径与符号
#   verify:legacy   是否残留旧方案（Meta Cloud API / whatsapp-cloud）的痕迹 legacy-ok
#   verify:imports  相对 import 是否都指向真实文件
#   verify:lockfile lockfile 的 resolved 不得指向公共 registry 之外的主机
npm run build         # 产出 dist/（提交前必跑）
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
git remote add origin git@github.com:ChihiroAF/openclaw-channel-whatsapp-evo.git   # 或 https://github.com/ChihiroAF/openclaw-channel-whatsapp-evo.git
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
# ref 换掉即可（main → v0.1.0 就是钉版本）
openclaw plugins install git:github.com/ChihiroAF/openclaw-channel-whatsapp-evo@main \
  --force --accept-capabilities
```

⚠️ **git 安装会在克隆后跑一次 `npm install --omit=dev`**（`git-install.ts:447-468`）。
本包**零运行时依赖**，且 lockfile 只含被 `--omit=dev` 排除掉的 devDependencies
⇒ 那一步不下载任何东西（已用"冷缓存 + registry 指向死端口"实测：exit 0）。
若某天又引入了运行时依赖，就会重新受 npm 12 的 `allow-remote` 闸门约束
（症状 `EALLOWREMOTE`，见上面「安装失败时怎么定位」），届时应优先考虑手写实现而不是加依赖。

演示/发布时把 `@main` 换成 tag：`git tag v0.1.0 && git push --tags` → `@v0.1.0`。

### 必须提交 / 必须忽略

| 提交 ✅ | 忽略 ⛔ |
|---|---|
| 源码：`index.ts` / `setup-entry.ts` / `api.ts` / `runtime-api.ts` / `src/**` | `node_modules/` |
| **`dist/`（构建产物，故意提交）** | `dist-pure/`（单测用构建输出） |
| `typings/`（SDK 占位声明，`npm run build` 需要） | `*.tgz`（`npm pack` 产物） |
| `scripts/`（四个校验脚本） | `*.log` / `coverage/` / `.env*` |
| `openclaw.plugin.json` / `package.json` / **`package-lock.json`**（⚠️ 必须提交，但 `resolved` 要先规范化） | `.DS_Store` / `Thumbs.db` / `.idea/` / `.vscode/` |
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
