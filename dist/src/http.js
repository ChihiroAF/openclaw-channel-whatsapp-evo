import { EVO_INSTANCE_HEADER, MAX_WEBHOOK_BODY_BYTES } from "./constants.js";
import { parseEvoWebhook } from "./payload.js";
/** 读取原始 body（超限即中断），返回值区分"超限"与"读失败" */
function readRawBody(req, limitBytes) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const finish = (result) => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(result);
        };
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > limitBytes) {
                // 与 controller 侧的 MaxWebhookBodyBytes 对齐（1MB）
                finish({ ok: false, reason: "too-large" });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
        req.on("error", () => finish({ ok: false, reason: "read-error" }));
    });
}
/** 取请求头里的单个值（同名多头时取第一个） */
function readHeader(req, name) {
    const raw = req.headers[name];
    if (typeof raw === "string") {
        return raw.trim();
    }
    if (Array.isArray(raw) && raw.length > 0) {
        return (raw[0] ?? "").trim();
    }
    return "";
}
/** 组装 webhook 的 HTTP handler（由 gateway 注册到插件路由表） */
export function createWabaEvoHttpHandler(params) {
    const limitBytes = params.bodyLimitBytes ?? MAX_WEBHOOK_BODY_BYTES;
    return async function handleWabaEvoHttpRequest(req, res) {
        const method = (req.method ?? "GET").toUpperCase();
        if (method !== "POST") {
            sendText(res, 405, "method not allowed");
            return;
        }
        const raw = await readRawBody(req, limitBytes);
        if (!raw.ok) {
            if (raw.reason === "too-large") {
                params.logger.warn?.(`[whatsapp-evo] inbound webhook exceeds ${limitBytes} bytes, rejected with 413`);
                sendText(res, 413, "payload too large");
                return;
            }
            params.logger.error?.("[whatsapp-evo] failed to read inbound webhook body");
            sendText(res, 400, "cannot read request body");
            return;
        }
        // 出站实例名必须来自请求头（payload 里的 instance 字段 v1/v2 形态不一致，不可依赖）
        const instanceName = readHeader(req, EVO_INSTANCE_HEADER);
        const parsed = parseEvoWebhook(raw.body);
        if (parsed.kind === "skip") {
            // **正常路径**：回执、连接状态、自己发的消息、群消息、媒体（v1 不投递）都走这里。
            // 记 INFO 即可，便于联调时判断"是没收到事件"还是"收到了但被判定为不可投递"。
            params.logger.info?.(`[whatsapp-evo] inbound skipped (reason=${parsed.reason}` +
                `${parsed.wamid ? `, wamid=${parsed.wamid}` : ""}` +
                `${instanceName ? `, instance=${instanceName}` : ", instance=<missing header>"})`);
            sendText(res, 200, "skipped");
            return;
        }
        if (parsed.kind === "media") {
            // v1 明确不做媒体：只记日志 + 200，避免 controller 侧出现"转发失败"的噪声，
            // 同时让运维能从这行日志看出"客户其实发了图片，只是我们没处理"。
            params.logger.info?.(`[whatsapp-evo] media message not delivered in v1 (type=${parsed.mediaType}, ` +
                `wamid=${parsed.wamid}, instance=${instanceName || "<missing header>"})`);
            sendText(res, 200, "media-ignored");
            return;
        }
        try {
            await params.dispatch(parsed.message, instanceName);
        }
        catch (error) {
            // 这里的失败必须让 controller 看见：它会把转发结果（含状态码）写进自己的日志，
            // 而 controller 已经先给 EVO 回过 200，所以不会造成上游重试风暴。
            params.logger.error?.(`[whatsapp-evo] inbound dispatch failed (wamid=${parsed.message.wamid}): ${error instanceof Error ? error.message : String(error)}`);
            sendText(res, 500, "dispatch failed");
            return;
        }
        sendText(res, 200, "ok");
    };
}
function sendText(res, status, body) {
    if (res.writableEnded || res.destroyed) {
        return;
    }
    res.statusCode = status;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(body);
}
