/**
 * `openclaw/plugin-sdk/*` 的**占位声明**。
 *
 * 为什么需要：本机不安装 openclaw（体积过大，且常拉不下来），所以 SDK 层的文件在本地
 * 无法解析这些 import ⇒ `tsc` 会因"找不到模块"而拒绝产出 JS，而 git/npm 安装又**要求自带编译产物**
 * （见 tsconfig.build.json 的注释）。
 *
 * ⚠️ 这里**刻意只做占位、不伪造类型**（`declare module` 的简写形式会让这些模块整体为 `any`）。
 * 伪造一套"看起来对"的类型只会制造虚假的安全感——真正的问题是"子路径/符号是否存在"，
 * 那由 `npm run verify:sdk` 对着 openclaw 源码逐条核对来兜。
 */
declare module "openclaw/plugin-sdk/*";
