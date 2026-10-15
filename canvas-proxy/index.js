#!/usr/bin/env node
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Readable, Transform } from "node:stream";
import { createRequestLog, ERROR_SAMPLE_BYTES, readRuntime, redact, safeError, safeTarget, sampledError } from "./request-log.js";
import * as adminStore from "./admin-store.js";
import { AUTH_ERRORS, handleAdminApi, handleReportChannel } from "./admin-api.js";

const pkg = createRequire(import.meta.url)("./package.json");

const CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "access-control-max-age": "86400",
};

/** Headers that describe the hop to this proxy rather than the upstream request. */
const SKIP_REQUEST_HEADERS = new Set(["host", "connection", "content-length", "accept-encoding", "origin", "referer", "sec-fetch-dest", "sec-fetch-mode", "sec-fetch-site", "x-access-key", "x-device-id", "x-admin-token"]);
/** fetch() already decoded and re-framed the body, so the upstream framing headers no longer apply. */
const SKIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

function readArg(args, name, fallback) {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
        req.on("aborted", () => reject(Object.assign(new Error("客户端取消请求"), { code: "CLIENT_ABORTED" })));
    });
}

function readTarget(url) {
    const raw = url.slice(1);
    // decodeURI undoes the escaping browsers apply to the path while keeping intentional encodeURIComponent escapes.
    let target = raw;
    try {
        target = decodeURI(raw);
    } catch {
        // Malformed escape sequence: forward the raw form instead of failing.
    }
    // Some clients collapse the "//" in the embedded target URL, so restore it before parsing.
    target = target.replace(/^(https?:)\/*/i, "$1//");
    return /^https?:\/\/[^/]/i.test(target) ? target : "";
}

function requestHeaders(req) {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (SKIP_REQUEST_HEADERS.has(key) || value === undefined) continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    return headers;
}

function responseHeaders(upstream) {
    const headers = { ...CORS_HEADERS };
    upstream.headers.forEach((value, key) => {
        if (SKIP_RESPONSE_HEADERS.has(key) || key.startsWith("access-control-")) return;
        headers[key] = value;
    });
    return headers;
}

function sendJson(res, status, payload) {
    res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(payload));
}

function logForward(method, target, outcome, startedAt) {
    try {
        console.log(`${new Date().toLocaleTimeString()} ${method} ${safeTarget(target)} -> ${redact(outcome)} ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    } catch {
        // 控制台日志失败不影响转发。
    }
}

async function forward(req, res, target, log) {
    const startedAt = Date.now();
    const record = log.start(req.method || "GET", target);
    const controller = new AbortController();
    let stream;
    let sampler;
    let sample = Buffer.alloc(0);
    let settled = false;
    const finish = (state, error) => {
        if (settled) return;
        settled = true;
        record.state = state;
        record.durationMs = Date.now() - startedAt;
        record.endedAt = new Date().toISOString();
        if (error) record.error = safeError(error);
        else if (record.status >= 400) record.error = sampledError(sample, record.status);
        log.save(record);
        req.off("aborted", cancel);
        res.off("close", onClose);
        res.off("finish", onFinish);
        logForward(record.method, target, `${record.status ?? "-"} ${state}`, startedAt);
    };
    const cancel = () => {
        finish("cancelled", { code: "CLIENT_ABORTED", message: "客户端取消请求" });
        controller.abort();
        stream?.destroy();
        sampler?.destroy();
    };
    const onClose = () => {
        if (!res.writableFinished) cancel();
    };
    const onFinish = () => finish(record.status >= 400 ? "error" : "success");
    req.once("aborted", cancel);
    res.once("close", onClose);
    res.once("finish", onFinish);
    try {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        if (settled || req.aborted || res.destroyed) {
            cancel();
            return;
        }
        if (body) {
            try {
                const model = JSON.parse(body.toString("utf8"))?.model;
                if (typeof model === "string") record.model = redact(model, 128);
            } catch {}
        }
        // 托管渠道：按最长前缀匹配注入服务器持有的上游 Key（浏览器不接触上游 Key）。
        const upstreamHeaders = requestHeaders(req);
        const channel = adminStore.matchChannelForTarget(target);
        if (channel) upstreamHeaders.authorization = `Bearer ${channel.apiKey}`;
        const upstream = await fetch(target, { method: req.method, headers: upstreamHeaders, body, redirect: "follow", signal: controller.signal });
        if (settled) {
            await upstream.body?.cancel();
            return;
        }
        record.status = upstream.status;
        record.headersAt = new Date().toISOString();
        record.durationMs = Date.now() - startedAt;
        record.state = "streaming";
        if (upstream.status >= 400) record.error = sampledError(sample, upstream.status);
        log.save(record);
        logForward(record.method, target, `${upstream.status} headers`, startedAt);
        res.writeHead(upstream.status, responseHeaders(upstream));
        res.flushHeaders();
        if (!upstream.body) {
            res.end();
            return;
        }
        stream = Readable.fromWeb(upstream.body);
        const failed = (error) => {
            if (settled) return;
            finish("error", error);
            controller.abort();
            stream.destroy();
            sampler?.destroy();
            res.destroy();
        };
        // 先记录上游错误再关闭客户端连接，避免将断流误记为客户端取消。
        stream.once("error", failed);
        res.once("error", failed);
        if (upstream.status >= 400) {
            sampler = new Transform({
                transform(chunk, encoding, callback) {
                    const remaining = ERROR_SAMPLE_BYTES - sample.length;
                    if (remaining > 0) sample = Buffer.concat([sample, chunk.subarray(0, remaining)]);
                    callback(null, chunk);
                },
            });
            sampler.once("error", failed);
            stream.pipe(sampler).pipe(res);
        } else {
            // SSE 不等待完整响应，保留 Node stream 的逐块转发和背压。
            stream.pipe(res);
        }
    } catch (error) {
        if (settled) return;
        finish("error", error);
        controller.abort();
        if (res.headersSent) res.destroy();
        else sendJson(res, 502, { error: safeError(error).message });
    }
}

function sendLogJson(res, status, payload) {
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(status === 405 ? { allow: "GET" } : {}),
    });
    res.end(JSON.stringify(payload));
}

export function createProxyServer() {
    const log = createRequestLog();
    return createServer((req, res) => {
        const path = (req.url || "/").split("?", 1)[0];
        if (path === "/__logs" || path === "/__runtime") {
            if (req.method !== "GET") {
                sendLogJson(res, 405, { error: "只允许 GET" });
                return;
            }
            const result = path === "/__logs"
                ? log.query(new URL(req.url, "http://localhost").searchParams)
                : readRuntime();
            result.then((payload) => {
                if (!res.destroyed) sendLogJson(res, 200, payload);
            }).catch((error) => {
                if (!res.destroyed) sendLogJson(res, 500, { error: safeError(error) });
            });
            return;
        }
        if (req.method === "OPTIONS") {
            res.writeHead(204, CORS_HEADERS);
            res.end();
            return;
        }
        if (path === "/admin-api" || path.startsWith("/admin-api/")) {
            handleAdminApi(req, res).catch((error) => {
                if (!res.headersSent) sendJson(res, 500, { error: safeError(error).message });
            });
            return;
        }
        if (path === "/report-channel") {
            handleReportChannel(req, res).catch(() => sendJson(res, 500, { error: "上报失败" }));
            return;
        }
        const target = readTarget(req.url || "/");
        if (!target) {
            const stats = adminStore.overview();
            sendJson(res, 200, { app: "infinite-canvas", proxy: pkg.name, version: pkg.version, usage: "/<full-target-url>", authEnforcement: stats.enforcement });
            return;
        }
        // 访问 Key + 设备绑定强制校验（引导模式：尚未签发任何 Key 时放行并照常登记设备）。
        const auth = adminStore.authenticate(req.headers["x-access-key"], req.headers["x-device-id"], { ip: req.socket?.remoteAddress || "", userAgent: req.headers["user-agent"] || "" });
        if (!auth.ok) {
            sendJson(res, auth.status, { error: AUTH_ERRORS[auth.code] || "访问被拒绝", code: auth.code });
            return;
        }
        forward(req, res, target, log).catch(() => {
            if (res.headersSent) res.destroy();
            else sendJson(res, 502, { error: "代理请求失败" });
        });
    });
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
    console.log(`${pkg.name} v${pkg.version}\n\nUsage: npx ${pkg.name}@latest [--port 23210] [--host 127.0.0.1]\n\nForwards http://<host>:<port>/<full-target-url> to <full-target-url> with permissive CORS headers.`);
    process.exit(0);
}

const port = Number(readArg(args, "port", process.env.PORT || 23210));
const host = readArg(args, "host", process.env.HOST || "127.0.0.1");

createProxyServer().listen(port, host, () => {
    console.log(`${pkg.name} v${pkg.version} listening on http://${host}:${port}`);
    console.log(`Fill this address into Infinite Canvas → 配置 → 本地代理: http://${host}:${port}`);
});
