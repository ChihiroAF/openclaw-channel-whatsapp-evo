import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WABA_EVO_CHANNEL_ID } from "../constants.js";
import {
  EVO_CHANNEL_ACCESS_FIELDS,
  EVO_CHANNEL_CONFIG_JSON_SCHEMA,
  EVO_CHANNEL_CONFIG_REQUIRED_FIELDS,
  parseEvoChannelConfig,
} from "../config-fields.js";

/**
 * 渠道配置有**三处**描述，必须互为同一份真值：
 *   1. `openclaw.plugin.json` 的 `channelConfigs["whatsapp-evo"].schema`（宿主读它建 setup UI / 校验）
 *   2. `EVO_CHANNEL_CONFIG_JSON_SCHEMA`（运行时传给 `buildJsonChannelConfigSchema`）
 *   3. `parseEvoChannelConfig()`（插件内部解析，见 accounts.ts）
 * 1 与 2 由本测试逐字比对；3 与 2 的关键不变量（必填项、严格模式）也在下面锁定。
 * 任何一处漂移都会让"controller 写进去了、插件读不到、且没有任何报错"重新出现。
 */
function readManifest(): Record<string, unknown> {
  const raw = readFileSync(join(process.cwd(), "openclaw.plugin.json"), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function manifestChannelSchema(): Record<string, unknown> {
  const manifest = readManifest();
  const channelConfigs = manifest["channelConfigs"] as Record<string, unknown> | undefined;
  const entry = channelConfigs?.[WABA_EVO_CHANNEL_ID] as Record<string, unknown> | undefined;
  assert.ok(entry, `清单缺少 channelConfigs.${WABA_EVO_CHANNEL_ID}`);
  const schema = entry["schema"] as Record<string, unknown> | undefined;
  assert.ok(schema, `清单缺少 channelConfigs.${WABA_EVO_CHANNEL_ID}.schema`);
  return schema;
}

test("清单里的渠道 schema 与运行时 schema 逐字一致（防两处漂移）", () => {
  assert.deepEqual(manifestChannelSchema(), EVO_CHANNEL_CONFIG_JSON_SCHEMA);
});

test("schema 的必填项与 EVO_CHANNEL_CONFIG_REQUIRED_FIELDS 一致", () => {
  assert.deepEqual(
    manifestChannelSchema()["required"],
    [...EVO_CHANNEL_CONFIG_REQUIRED_FIELDS],
    "schema.required 必须来自同一份常量，否则文档/测试与运行时校验会脱节",
  );
});

test("schema 是严格模式（additionalProperties:false），与手写校验的拒绝行为一致", () => {
  assert.equal(manifestChannelSchema()["additionalProperties"], false);
  // 手写校验必须同样拒绝未声明字段，否则运行时比 schema 宽松 = 静默接受错字段
  const withUnknown = parseEvoChannelConfig({
    evoBaseUrl: "https://e",
    evoApiKey: "k",
    phoneNumberId: "123", // legacy-ok 故意的：拿一个 Meta 时代的字段名当"未声明字段"的样本
  });
  assert.equal(withUnknown.ok, false);
});

test("schema 放行了 core 管理的 accounts 容器键", () => {
  const properties = manifestChannelSchema()["properties"] as Record<string, unknown>;
  assert.ok(Object.hasOwn(properties, "accounts"), "accounts 必须放行，否则多账号配置会被判非法");
});

test("schema 允许 controller 写入的准入字段（dmPolicy / allowFrom）", () => {
  const properties = manifestChannelSchema()["properties"] as Record<string, unknown>;
  for (const key of Object.keys(EVO_CHANNEL_ACCESS_FIELDS)) {
    assert.ok(Object.hasOwn(properties, key), `schema 必须声明 ${key}，否则 bind 写入后会被判非法`);
  }
});

test("dmPolicy 枚举与运行时手写校验接受的值一致", () => {
  const properties = manifestChannelSchema()["properties"] as Record<string, Record<string, unknown>>;
  const allowed = properties["dmPolicy"]?.["enum"] as string[] | undefined;
  assert.deepEqual(allowed, ["open", "allowlist", "pairing"]);
  for (const policy of allowed ?? []) {
    const parsed = parseEvoChannelConfig({ evoBaseUrl: "https://e", evoApiKey: "k", dmPolicy: policy });
    assert.equal(parsed.ok, true, `手写校验应接受 dmPolicy=${policy}`);
  }
});
