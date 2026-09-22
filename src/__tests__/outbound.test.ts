import assert from "node:assert/strict";
import test from "node:test";

import { EvoClientError } from "../evo-client.js";
import { maskRecipient, truncate } from "../logger.js";
import { resolveEvoInstanceName, sendEvoText, type EvoChannelConfig } from "../outbound.js";

type Captured = { url: string; init: RequestInit | undefined };

function captureFetch(
  responder: () => Response | Promise<Response>,
  captured: Captured[],
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured.push({ url: String(input), init });
    return await responder();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function captureLogger(): { lines: string[]; logger: { debug: (m: string) => void } } {
  const lines: string[] = [];
  return { lines, logger: { debug: (message: string) => lines.push(message) } };
}

const baseConfig: EvoChannelConfig = {
  evoBaseUrl: "https://ev-api.example.com",
  evoApiKey: "secret-key",
};

test("resolveEvoInstanceName 请求头优先于配置兜底", () => {
  assert.equal(
    resolveEvoInstanceName({
      instanceNameFromHeader: "from-header",
      configInstanceName: "from-config",
    }),
    "from-header",
  );
});

test("resolveEvoInstanceName 头为空时回退配置", () => {
  assert.equal(
    resolveEvoInstanceName({ instanceNameFromHeader: "   ", configInstanceName: "from-config" }),
    "from-config",
  );
  assert.equal(
    resolveEvoInstanceName({ instanceNameFromHeader: "", configInstanceName: "from-config" }),
    "from-config",
  );
});

test("resolveEvoInstanceName 两者都缺时明确抛错（绝不猜测）", () => {
  assert.throws(
    () => resolveEvoInstanceName({ instanceNameFromHeader: "", configInstanceName: undefined }),
    /instance name is unavailable/,
  );
  assert.throws(
    () => resolveEvoInstanceName({ instanceNameFromHeader: " ", configInstanceName: "  " }),
    /instance name is unavailable/,
  );
});

test("sendEvoText 走通：号码归一 + 正确的 URL/头/body + 日志脱敏", async () => {
  const captured: Captured[] = [];
  const { lines, logger } = captureLogger();

  const result = await sendEvoText({
    config: baseConfig,
    instanceNameFromHeader: "inst-1",
    to: "8613800138000:12@s.whatsapp.net",
    text: "  你好  ",
    logger,
    fetchImpl: captureFetch(
      () => jsonResponse({ key: { id: "wamid.REPLY" }, status: "PENDING" }),
      captured,
    ),
  });

  const request = captured[0]!;
  assert.equal(request.url, "https://ev-api.example.com/message/sendText/inst-1");
  const headers = request.init?.headers as Record<string, string>;
  assert.equal(headers["apikey"], "secret-key");
  // 发送目标必须是归一后的纯数字（去掉设备位），正文去掉首尾空白
  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    number: "8613800138000",
    text: "你好",
  });

  assert.deepEqual(result, { messageId: "wamid.REPLY", to: "8613800138000", evoStatus: "PENDING" });

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /text sent to \*+8000 via instance inst-1/);
  // NFR-3：完整号码绝不能出现在日志里
  assert.ok(!lines[0]!.includes("8613800138000"), `日志泄漏了完整号码: ${lines[0]}`);
});

test("sendEvoText 对无法解析的收件人抛错，且不发请求", async () => {
  const captured: Captured[] = [];
  await assert.rejects(
    () =>
      sendEvoText({
        config: baseConfig,
        instanceNameFromHeader: "inst-1",
        to: "not-a-number",
        text: "你好",
        logger: {},
        fetchImpl: captureFetch(() => jsonResponse({}), captured),
      }),
    /cannot resolve a valid EVO recipient number/,
  );
  assert.equal(captured.length, 0);
});

test("sendEvoText 对空回复抛错，且不发请求", async () => {
  const captured: Captured[] = [];
  await assert.rejects(
    () =>
      sendEvoText({
        config: baseConfig,
        instanceNameFromHeader: "inst-1",
        to: "8613800138000",
        text: "   \n ",
        logger: {},
        fetchImpl: captureFetch(() => jsonResponse({}), captured),
      }),
    /refusing to send an empty text reply/,
  );
  assert.equal(captured.length, 0);
});

test("sendEvoText 原样透传 EVO 的失败状态码与响应摘要", async () => {
  await assert.rejects(
    () =>
      sendEvoText({
        config: baseConfig,
        instanceNameFromHeader: "inst-1",
        to: "8613800138000",
        text: "你好",
        logger: {},
        fetchImpl: captureFetch(
          () => new Response('{"status":401,"error":"Unauthorized"}', { status: 401 }),
          [],
        ),
      }),
    (error: unknown) => {
      assert.ok(error instanceof EvoClientError);
      assert.equal(error.httpStatus, 401);
      assert.match(error.responseExcerpt, /Unauthorized/);
      return true;
    },
  );
});

test("sendEvoText 在头缺失时用 config.evoInstanceId 兜底", async () => {
  const captured: Captured[] = [];
  await sendEvoText({
    config: { ...baseConfig, evoInstanceId: "inst-from-config" },
    instanceNameFromHeader: "",
    to: "8613800138000",
    text: "你好",
    logger: {},
    fetchImpl: captureFetch(() => jsonResponse({ key: { id: "x" } }), captured),
  });
  assert.equal(captured[0]!.url, "https://ev-api.example.com/message/sendText/inst-from-config");
});

test("maskRecipient 只保留后四位", () => {
  assert.equal(maskRecipient("8613800138000"), "*********8000");
  assert.equal(maskRecipient("1234"), "****");
  assert.equal(maskRecipient("12"), "**");
  assert.equal(maskRecipient(""), "*");
});

test("truncate 超长时截断并标注原长度", () => {
  assert.equal(truncate("abc", 10), "abc");
  const long = "x".repeat(20);
  const cut = truncate(long, 5);
  assert.match(cut, /^xxxxx…\(truncated, 20 chars total\)$/);
});
