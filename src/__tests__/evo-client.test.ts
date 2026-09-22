import assert from "node:assert/strict";
import test from "node:test";

import {
  EvoClient,
  EvoClientError,
  buildSendTextBody,
  extractEvoMessageId,
  extractEvoStatus,
  normalizeEvoBaseUrl,
  toEvoNumber,
} from "../evo-client.js";

type Captured = { url: string; init: RequestInit | undefined };

/** 造一个假 fetch，把请求录下来供断言（不触网） */
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

test("normalizeEvoBaseUrl 规范化协议/尾部斜杠/子路径", () => {
  assert.equal(normalizeEvoBaseUrl("https://ev-api.example.com"), "https://ev-api.example.com");
  assert.equal(normalizeEvoBaseUrl("https://ev-api.example.com/"), "https://ev-api.example.com");
  assert.equal(normalizeEvoBaseUrl("https://ev-api.example.com///"), "https://ev-api.example.com");
  // 手填配置最容易漏协议
  assert.equal(normalizeEvoBaseUrl("ev-api.example.com"), "https://ev-api.example.com");
  // 允许部署在子路径下，但要去掉尾部斜杠（否则会拼出 //message/sendText）
  assert.equal(normalizeEvoBaseUrl("https://host/evo/"), "https://host/evo");
  assert.equal(normalizeEvoBaseUrl("  https://host  "), "https://host");
});

test("normalizeEvoBaseUrl 对非法值尽早抛错", () => {
  assert.throws(() => normalizeEvoBaseUrl(""), /evoBaseUrl is empty/);
  assert.throws(() => normalizeEvoBaseUrl("   "), /evoBaseUrl is empty/);
  // 显式写了非 http(s) 协议要拦掉：否则会被补成 https://ftp://host 而被 URL 解析器"洗白"
  assert.throws(() => normalizeEvoBaseUrl("ftp://host"), /must be http\(s\)/);
  assert.throws(() => normalizeEvoBaseUrl("ws://host"), /must be http\(s\)/);
  assert.throws(() => normalizeEvoBaseUrl("https://"), /not a valid URL/);
});

test("normalizeEvoBaseUrl 不把裸 host:port 误判成协议", () => {
  assert.equal(normalizeEvoBaseUrl("host:8080"), "https://host:8080");
});

test("toEvoNumber 去掉后缀/设备位/非数字字符", () => {
  assert.equal(toEvoNumber("8613800138000"), "8613800138000");
  assert.equal(toEvoNumber("8613800138000@s.whatsapp.net"), "8613800138000");
  assert.equal(toEvoNumber("8613800138000:12@s.whatsapp.net"), "8613800138000");
  assert.equal(toEvoNumber("+86 138-0013-8000"), "8613800138000");
  assert.equal(toEvoNumber(" 8613800138000 "), "8613800138000");
});

test("toEvoNumber 对非法值返回 undefined", () => {
  assert.equal(toEvoNumber(""), undefined);
  assert.equal(toEvoNumber("status@broadcast"), undefined);
  assert.equal(toEvoNumber("abc"), undefined);
  // 注意：群 JID 的号码部分本身是数字，靠号码校验拦不住 —— 群消息由 payload.ts 在更早一步丢弃
  assert.equal(toEvoNumber("8613800138000-123456@g.us"), "8613800138000123456");
});

test("buildSendTextBody 是 v2 形态（text 为字符串）", () => {
  assert.deepEqual(buildSendTextBody("8613800138000", "你好"), {
    number: "8613800138000",
    text: "你好",
  });
});

test("extractEvoMessageId 兼容 key.id / id / messageId / data 包裹", () => {
  assert.equal(extractEvoMessageId({ key: { id: "wamid.A" } }), "wamid.A");
  assert.equal(extractEvoMessageId({ id: "plain-id" }), "plain-id");
  assert.equal(extractEvoMessageId({ messageId: "mid-1" }), "mid-1");
  assert.equal(extractEvoMessageId({ data: { key: { id: "wamid.B" } } }), "wamid.B");
  assert.equal(extractEvoMessageId({ status: "PENDING" }), "");
  assert.equal(extractEvoMessageId(undefined), "");
  assert.equal(extractEvoMessageId("not-an-object"), "");
});

test("extractEvoStatus 兼容直接字段与 data 包裹", () => {
  assert.equal(extractEvoStatus({ status: "PENDING" }), "PENDING");
  assert.equal(extractEvoStatus({ data: { status: "SENT" } }), "SENT");
  assert.equal(extractEvoStatus({}), "");
  assert.equal(extractEvoStatus(undefined), "");
});

test("EvoClient 构造时校验 apiKey 与 baseUrl", () => {
  assert.throws(
    () => new EvoClient({ baseUrl: "https://host", apiKey: "  " }),
    /evoApiKey is empty/,
  );
  assert.throws(() => new EvoClient({ baseUrl: "", apiKey: "k" }), /evoBaseUrl is empty/);
});

test("EvoClient.sendText 拼对 URL、带头、带 v2 body", async () => {
  const captured: Captured[] = [];
  const client = new EvoClient({
    baseUrl: "https://ev-api.example.com/",
    apiKey: "secret-key",
    fetchImpl: captureFetch(
      () => jsonResponse({ key: { id: "wamid.OK" }, status: "PENDING" }),
      captured,
    ),
  });

  const result = await client.sendText({
    instanceName: "inst-abc",
    number: "8613800138000",
    text: "你好",
  });

  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, "https://ev-api.example.com/message/sendText/inst-abc");
  assert.equal(request.init?.method, "POST");

  const headers = request.init?.headers as Record<string, string>;
  assert.equal(headers["apikey"], "secret-key");
  assert.equal(headers["Content-Type"], "application/json");

  assert.deepEqual(JSON.parse(String(request.init?.body)), {
    number: "8613800138000",
    text: "你好",
  });

  assert.deepEqual(result, { messageId: "wamid.OK", status: "PENDING", httpStatus: 201 });
});

test("EvoClient.sendText 对实例名做 URL 编码（防止路径逃逸）", async () => {
  const captured: Captured[] = [];
  const client = new EvoClient({
    baseUrl: "https://host",
    apiKey: "k",
    fetchImpl: captureFetch(() => jsonResponse({ key: { id: "x" } }), captured),
  });

  await client.sendText({ instanceName: "a/../b", number: "8613800138000", text: "hi" });
  assert.equal(captured[0]!.url, "https://host/message/sendText/a%2F..%2Fb");
});

test("EvoClient.sendText 缺实例名时明确抛错", async () => {
  const client = new EvoClient({
    baseUrl: "https://host",
    apiKey: "k",
    fetchImpl: captureFetch(() => jsonResponse({}), []),
  });
  await assert.rejects(
    () => client.sendText({ instanceName: "  ", number: "8613800138000", text: "hi" }),
    /instance name is missing/,
  );
});

test("EvoClient.sendText 非 2xx 时抛 EvoClientError，保留状态码与响应摘要", async () => {
  const client = new EvoClient({
    baseUrl: "https://host",
    apiKey: "k",
    fetchImpl: captureFetch(
      () => new Response('{"status":400,"error":"Bad Request","message":["number must be a number string"]}', { status: 400 }),
      [],
    ),
  });

  await assert.rejects(
    () => client.sendText({ instanceName: "inst", number: "8613800138000", text: "hi" }),
    (error: unknown) => {
      assert.ok(error instanceof EvoClientError);
      assert.equal(error.httpStatus, 400);
      assert.match(error.responseExcerpt, /number must be a number string/);
      assert.equal(error.timedOut, false);
      return true;
    },
  );
});

test("EvoClient.sendText 网络失败时抛 EvoClientError（httpStatus=0）", async () => {
  const failing = (async () => {
    throw new Error("connect ECONNREFUSED");
  }) as unknown as typeof fetch;

  const client = new EvoClient({ baseUrl: "https://host", apiKey: "k", fetchImpl: failing });
  await assert.rejects(
    () => client.sendText({ instanceName: "inst", number: "8613800138000", text: "hi" }),
    (error: unknown) => {
      assert.ok(error instanceof EvoClientError);
      assert.equal(error.httpStatus, 0);
      assert.equal(error.timedOut, false);
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    },
  );
});

test("EvoClient.sendText 超时时标记 timedOut", async () => {
  const timingOut = (async () => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }) as unknown as typeof fetch;

  const client = new EvoClient({ baseUrl: "https://host", apiKey: "k", fetchImpl: timingOut });
  await assert.rejects(
    () => client.sendText({ instanceName: "inst", number: "8613800138000", text: "hi" }),
    (error: unknown) => {
      assert.ok(error instanceof EvoClientError);
      assert.equal(error.timedOut, true);
      assert.match(error.message, /timed out/);
      return true;
    },
  );
});

test("EvoClient.sendText 对 2xx 但非 JSON 响应体不视为失败", async () => {
  const client = new EvoClient({
    baseUrl: "https://host",
    apiKey: "k",
    fetchImpl: captureFetch(() => new Response("<html>ok</html>", { status: 201 }), []),
  });

  const result = await client.sendText({ instanceName: "inst", number: "8613800138000", text: "hi" });
  assert.deepEqual(result, { messageId: "", status: "", httpStatus: 201 });
});
