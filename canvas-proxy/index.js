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

/** /auth/verify 同 IP 限流：每分钟 30 次（滑动窗口，超限 429），防 Key 状态探测滥用。 */
const verifyRate = new Map();
function verifyRateOk(ip) {
    const now = Date.now();
    let entry = verifyRate.get(ip);
    if (!entry || now - entry.windowStart > 60_000) {
        entry = { count: 0, windowStart: now };
        verifyRate.set(ip, entry);
        if (verifyRate.size > 10_000) for (const [key, value] of verifyRate) if (now - value.windowStart > 60_000) verifyRate.delete(key);
    }
    entry.count += 1;
    return entry.count <= 30;
}

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

// ---- 平台渠道请求体模型别名改写（真实模型名绝不下发浏览器，服务端按 alias→model 映射换回）----
function transformManagedModelBody(body, contentType, aliasMap) {
    if (!aliasMap || aliasMap.size === 0) return body;
    const ctype = String(contentType).toLowerCase();
    if (ctype.includes("application/json")) {
        try {
            const parsed = JSON.parse(body.toString("utf8"));
            if (parsed && typeof parsed.model === "string" && aliasMap.has(parsed.model)) {
                parsed.model = aliasMap.get(parsed.model);
                return Buffer.from(JSON.stringify(parsed), "utf8");
            }
        } catch {}
        return body;
    }
    if (ctype.includes("multipart/form-data")) {
        const replaced = replaceMultipartModel(body, contentType, aliasMap);
        if (replaced) return replaced;
    }
    return body;
}

function replaceMultipartModel(body, contentType, aliasMap) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
    if (!match) return null;
    const dashBoundary = Buffer.from(`--${(match[1] || match[2]).trim()}`, "utf8");
    const segments = [];
    let idx = body.indexOf(dashBoundary);
    while (idx !== -1) {
        const next = body.indexOf(dashBoundary, idx + dashBoundary.length);
        segments.push(body.slice(idx, next === -1 ? body.length : next));
        if (next === -1) break;
        idx = next;
    }
    if (segments.length < 2) return null;
    let changed = false;
    const rebuilt = segments.map((seg) => {
        const headerEnd = seg.indexOf("\r\n\r\n");
        if (headerEnd === -1) return seg;
        const headers = seg.slice(0, headerEnd).toString("utf8");
        if (!/(^|[;\s])name="model"/i.test(headers)) return seg;
        const trailingCrlf = seg.length >= 2 && seg[seg.length - 2] === 13 && seg[seg.length - 1] === 10 ? 2 : 0;
        const content = seg.slice(headerEnd + 4, seg.length - trailingCrlf);
        const value = content.toString("utf8");
        if (!aliasMap.has(value)) return seg;
        changed = true;
        return Buffer.concat([seg.slice(0, headerEnd + 4), Buffer.from(aliasMap.get(value), "utf8"), trailingCrlf ? Buffer.from("\r\n") : Buffer.alloc(0)]);
    });
    return changed ? Buffer.concat(rebuilt) : null;
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

async function forward(req, res, target, log, options) {
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
    const upstreamHeadersInit = requestHeaders(req);
    try {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
        if (settled || req.aborted || res.destroyed) {
            cancel();
            return;
        }
        // 平台渠道别名改写：请求体里的 model=显示别名 换回真实模型名（真实名绝不下发浏览器）。
        let forwardBody = body;
        if (body && typeof options?.transformBody === "function") {
            try {
                const transformed = options.transformBody(body, req.headers["content-type"] || "");
                if (transformed && transformed.length !== body.length) {
                    forwardBody = transformed;
                    upstreamHeadersInit["content-length"] = String(transformed.length);
                } else if (transformed) forwardBody = transformed;
            } catch {}
        }
        if (forwardBody) {
            try {
                const model = JSON.parse(forwardBody.toString("utf8"))?.model;
                if (typeof model === "string") record.model = redact(model, 128);
            } catch {}
        }
        // 托管渠道：按最长前缀匹配注入服务器持有的上游 Key（浏览器不接触上游 Key）。
        const upstreamHeaders = { ...upstreamHeadersInit };
        const channel = adminStore.matchChannelForTarget(target);
        if (channel) upstreamHeaders.authorization = `Bearer ${channel.apiKey}`;
        const upstream = await fetch(target, { method: req.method, headers: upstreamHeaders, body: forwardBody, redirect: "follow", signal: controller.signal });
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
        // 全屏密钥门探测端点（免鉴权、只读、同 IP 限流 30 次/分钟）：前端启动/刷新时调用。
        if (path === "/auth/verify") {
            if (!verifyRateOk(req.socket?.remoteAddress || "")) {
                sendJson(res, 429, { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
                return;
            }
            const result = adminStore.verifyAccess(req.headers["x-access-key"], req.headers["x-device-id"]);
            sendJson(res, 200, result);
            return;
        }
        // 进门即登记设备（POST /auth/bind）：走真实 authenticate（登记台账/校验 maxDevices），限流与 verify 共用。
        if (path === "/auth/bind") {
            if ((req.method || "") !== "POST") {
                sendJson(res, 405, { error: "只允许 POST" });
                return;
            }
            if (!verifyRateOk(req.socket?.remoteAddress || "")) {
                sendJson(res, 429, { error: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" });
                return;
            }
            const auth = adminStore.authenticate(req.headers["x-access-key"], req.headers["x-device-id"], { ip: req.socket?.remoteAddress || "", userAgent: req.headers["user-agent"] || "" });
            if (!auth.ok) {
                sendJson(res, auth.status, { error: AUTH_ERRORS[auth.code] || "访问被拒绝", code: auth.code });
                return;
            }
            sendJson(res, 200, { ok: true, bootstrap: !!auth.bootstrap, device: auth.device ? { id: auth.device.id, lastSeen: auth.device.lastSeen } : null });
            return;
        }
        // 平台渠道分发（需有效访问 Key）：渠道清单绝不含 baseUrl/apiKey；内部转发由服务端换算真实上游并注入 Bearer。
        // 兼容两种到达形态：同源代理（vite 剥前缀 → /__managed...）与经典本地代理（/canvas-api/__managed...）。
        const managedPath = path.startsWith("/canvas-api/__managed") ? path.slice("/canvas-api".length) : path;
        if (managedPath === "/__managed-channels") {
            const auth = adminStore.authenticate(req.headers["x-access-key"], req.headers["x-device-id"], { ip: req.socket?.remoteAddress || "", userAgent: req.headers["user-agent"] || "" });
            if (!auth.ok) {
                sendJson(res, auth.status, { error: AUTH_ERRORS[auth.code] || "访问被拒绝", code: auth.code });
                return;
            }
            sendJson(res, 200, { channels: adminStore.listManagedChannelsPublic() });
            return;
        }
        if (managedPath === "/__managed" || managedPath.startsWith("/__managed/")) {
            const auth = adminStore.authenticate(req.headers["x-access-key"], req.headers["x-device-id"], { ip: req.socket?.remoteAddress || "", userAgent: req.headers["user-agent"] || "" });
            if (!auth.ok) {
                sendJson(res, auth.status, { error: AUTH_ERRORS[auth.code] || "访问被拒绝", code: auth.code });
                return;
            }
            const rest = managedPath.slice("/__managed/".length);
            const slash = rest.indexOf("/");
            const channelId = slash === -1 ? rest : rest.slice(0, slash);
            const endpointPathRaw = slash === -1 ? "" : rest.slice(slash);
            if (!/^[0-9a-f]{8,64}$/i.test(channelId) || !endpointPathRaw.startsWith("/") || endpointPathRaw.includes("..")) {
                sendJson(res, 404, { error: "平台渠道不存在或路径非法", code: "MANAGED_CHANNEL_NOT_FOUND" });
                return;
            }
            // 版本归一：客户端可能带版本段（gemini /v1beta、video-generations /v1）或不带（buildApiUrl 平台分支）。
            // 记住客户端版本段并剥离；真实 baseUrl 自带 /vN 则用之，否则用客户端版本段（缺省 /v1）补齐。
            let endpointPath = endpointPathRaw;
            const channel = adminStore.findChannelById(channelId);
            if (!channel) {
                sendJson(res, 404, { error: "平台渠道不存在或已下线", code: "MANAGED_CHANNEL_NOT_FOUND" });
                return;
            }
            const versionMatch = endpointPath.match(/^\/v\d+(?:beta\d*)?(?=\/)/i);
            const clientVersion = versionMatch ? versionMatch[0] : "";
            if (clientVersion) endpointPath = endpointPath.slice(clientVersion.length);
            const channelBase = channel.baseUrl;
            const apiBase = /\/v\d+(?:beta\d*)?$/i.test(channelBase) ? channelBase : `${channelBase}${clientVersion || "/v1"}`;
            const queryIndex = (req.url || "").indexOf("?");
            const search = queryIndex >= 0 ? (req.url || "").slice(queryIndex) : "";
            const managedTarget = `${apiBase}${endpointPath}${search}`;
            const aliasMap = adminStore.managedModelAliasMap(channel);
            forward(req, res, managedTarget, log, { transformBody: (body, contentType) => transformManagedModelBody(body, contentType, aliasMap) }).catch(() => {
                if (res.headersSent) res.destroy();
                else sendJson(res, 502, { error: "代理请求失败" });
            });
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
