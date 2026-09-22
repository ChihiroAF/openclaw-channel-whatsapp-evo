import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ACCOUNT_ID,
  isValidEvoChannelConfig,
  listEvoAccountIds,
  readEvoChannelSection,
  resolveDefaultEvoAccountId,
  resolveEvoAccount,
} from "../accounts.js";
import {
  EVO_CHANNEL_ACCESS_FIELDS,
  EVO_CHANNEL_CONFIG_REQUIRED_FIELDS,
  checkEvoAccessConfig,
} from "../config-fields.js";

/**
 * ⚠️ 这个对象就是 **controller 的 bind 接口会写进实例 openclaw.json 的内容**。
 * 字段名一旦与 controller 侧不一致，插件读不到配置且**没有任何报错**，
 * 所以这里把"契约"硬编码一份：谁改了名字，这个测试就会红，逼着两边同步。
 */
function configWrittenByController(): Record<string, unknown> {
  return {
    evoBaseUrl: "https://ev-api.example.com",
    evoApiKey: "k".repeat(64),
    dmPolicy: "open",
    allowFrom: ["*"],
  };
}

function cfgWithChannel(section: unknown): unknown {
  return { channels: { "whatsapp-evo": section } };
}

test("字段契约：bind 写入的字段名与位置必须逐字一致", () => {
  assert.deepEqual([...EVO_CHANNEL_CONFIG_REQUIRED_FIELDS], ["evoBaseUrl", "evoApiKey"]);
  assert.deepEqual(EVO_CHANNEL_ACCESS_FIELDS, { dmPolicy: "open", allowFrom: ["*"] });
});

test("readEvoChannelSection 只在正确路径下取到配置", () => {
  assert.deepEqual(readEvoChannelSection(cfgWithChannel({ evoBaseUrl: "x" })), { evoBaseUrl: "x" });
  assert.equal(readEvoChannelSection({}), undefined);
  assert.equal(readEvoChannelSection({ channels: {} }), undefined);
  assert.equal(readEvoChannelSection({ channels: { "whatsapp-cloud": {} } }), undefined); // legacy-ok 故意的：旧渠道段不该被读到
  assert.equal(readEvoChannelSection(undefined), undefined);
});

test("缺少配置段时 configured=false 并给出原因（不抛异常）", () => {
  const account = resolveEvoAccount({ cfg: {} });
  assert.equal(account.configured, false);
  assert.equal(account.accountId, DEFAULT_ACCOUNT_ID);
  assert.match(account.configError ?? "", /channels\.whatsapp-evo is not present/);
});

test("controller 写入的配置能被正确解析（联调前的契约回归测试）", () => {
  const account = resolveEvoAccount({ cfg: cfgWithChannel(configWrittenByController()) });

  assert.equal(account.configured, true);
  assert.equal(account.enabled, true);
  assert.equal(account.evoBaseUrl, "https://ev-api.example.com");
  assert.equal(account.evoApiKey, "k".repeat(64));
  assert.equal(account.dmPolicy, "open");
  assert.deepEqual(account.allowFrom, ["*"]);
  // 准入配对了就不该有告警
  assert.equal(account.accessWarning, undefined);
  assert.equal(account.configError, undefined);
});

test("缺少 evoApiKey 时报错且不泄漏任何字段值", () => {
  const account = resolveEvoAccount({
    cfg: cfgWithChannel({ evoBaseUrl: "https://ev-api.example.com", evoApiKey: "" }),
  });
  assert.equal(account.configured, false);
  assert.match(account.configError ?? "", /evoApiKey/);
  assert.ok(!(account.configError ?? "").includes("example.com"), "配置错误信息里不应出现字段值");
});

test("strict schema：controller 多写未声明字段会被显式拒绝，而不是静默忽略", () => {
  // legacy-ok 故意的：拿一个 Meta 时代的字段名当"未声明字段"的样本
  const account = resolveEvoAccount({
    cfg: cfgWithChannel({ ...configWrittenByController(), phoneNumberId: "123456789012345" }), // legacy-ok
  });
  assert.equal(account.configured, false);
  assert.match(account.configError ?? "", /phoneNumberId/); // legacy-ok
});

test("enabled:false 才算关闭；缺席视为开启（与核心语义一致）", () => {
  assert.equal(
    resolveEvoAccount({ cfg: cfgWithChannel({ ...configWrittenByController(), enabled: false }) })
      .enabled,
    false,
  );
  assert.equal(
    resolveEvoAccount({ cfg: cfgWithChannel(configWrittenByController()) }).enabled,
    true,
  );
});

test("核心管理的 accounts 容器键不会破坏 strict 校验", () => {
  const account = resolveEvoAccount({
    cfg: cfgWithChannel({ ...configWrittenByController(), accounts: { default: {} } }),
  });
  assert.equal(account.configured, true);
});

test("多账号：accounts 下的同账号覆盖渠道级字段", () => {
  const cfg = cfgWithChannel({
    ...configWrittenByController(),
    accounts: { sales: { evoInstanceId: "inst-sales" } },
  });
  assert.deepEqual(listEvoAccountIds(cfg), ["sales"]);
  // accounts 非空时默认账号不是 "default"
  assert.equal(resolveDefaultEvoAccountId(cfg), "sales");

  const account = resolveEvoAccount({ cfg, accountId: "sales" });
  assert.equal(account.configured, true);
  assert.equal(account.evoInstanceId, "inst-sales");
  // 渠道级字段仍然继承
  assert.equal(account.evoBaseUrl, "https://ev-api.example.com");
});

test("账号清单：配置段缺失返回空数组（= 未配置）", () => {
  assert.deepEqual(listEvoAccountIds({}), []);
  assert.deepEqual(listEvoAccountIds(cfgWithChannel(configWrittenByController())), [
    DEFAULT_ACCOUNT_ID,
  ]);
  assert.equal(resolveDefaultEvoAccountId({}), DEFAULT_ACCOUNT_ID);
});

test("准入告警：dmPolicy 缺席（核心默认 pairing）会被点名", () => {
  const warning = checkEvoAccessConfig({});
  assert.match(warning ?? "", /dmPolicy is "pairing"/);
  // 光有 open 不够，allowFrom 必须有通配项
  const warning2 = checkEvoAccessConfig({ dmPolicy: "open", allowFrom: [] });
  assert.match(warning2 ?? "", /no wildcard/);
  assert.equal(checkEvoAccessConfig({ dmPolicy: "open", allowFrom: ["*"] }), undefined);
});

test("准入告警会挂到 account 上供启动时打日志", () => {
  const account = resolveEvoAccount({
    cfg: cfgWithChannel({ evoBaseUrl: "https://e", evoApiKey: "k" }),
  });
  assert.equal(account.configured, true);
  assert.match(account.accessWarning ?? "", /dmPolicy is "pairing"/);
});

test("isValidEvoChannelConfig 与 schema 行为一致", () => {
  assert.equal(isValidEvoChannelConfig(configWrittenByController()), true);
  assert.equal(isValidEvoChannelConfig({ evoBaseUrl: "https://e" }), false);
  assert.equal(isValidEvoChannelConfig({ evoBaseUrl: "https://e", evoApiKey: "k", x: 1 }), false);
});
