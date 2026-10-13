import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, open, chmod, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

function envNumber(name, fallback, min, max) {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export const ERROR_SAMPLE_BYTES = envNumber("CANVAS_REQUEST_LOG_ERROR_BYTES", 8192, 256, 65536);
const MAX_ITEMS = 500;
const SERVICES = ["infinite-canvas-web", "infinite-canvas-proxy"];

export function safeTarget(value) {
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol)) return "";
        return redact(`${url.origin}${url.pathname}`, 2048, false);
    } catch {
        return "";
    }
}

export function redact(value, limit = 1024, urls = true) {
    let text = typeof value === "string" || typeof value === "number" ? String(value) : "";
    if (urls) text = text.replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => safeTarget(url));
    // 这些字段可能包含任意长的用户内容，整段消息丢弃比猜测其边界更安全。
    if (/(?:["']?)(?:prompt|image|images|headers)(?:["']?)\s*[:=]/i.test(text)) return "[REDACTED CONTENT]";
    return text
        .replace(/\bbearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
        .replace(/\bsk-[a-z0-9_-]+/gi, "[REDACTED]")
        .replace(/((?:["']?)(?:authorization|api[-_]?key|key|token|access[-_]?token|refresh[-_]?token|secret|password|prompt|image|images|headers)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, "$1[REDACTED]")
        .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, "[REDACTED]")
        .replace(/data:image\/[^\s"']+/gi, "[REDACTED]")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .slice(0, limit);
}

export function safeError(error, fallback = "UPSTREAM_ERROR") {
    const source = error && typeof error === "object" ? error : {};
    return {
        code: redact(source.code ?? source.cause?.code ?? fallback, 128),
        message: redact(source.message ?? (typeof error === "string" ? error : fallback)),
        traceId: redact(source.traceId ?? source.trace_id ?? source.request_id ?? source.requestId ?? "", 256),
    };
}

export function sampledError(sample, status) {
    let source;
    try {
        const payload = JSON.parse(sample.toString("utf8"));
        source = payload?.error && typeof payload.error === "object" ? payload.error : payload;
        return safeError({
            code: source?.code ?? source?.type ?? `HTTP_${status}`,
            message: source?.message ?? (typeof payload?.error === "string" ? payload.error : `上游返回 HTTP ${status}`),
            traceId: source?.traceId ?? source?.trace_id ?? source?.request_id ?? payload?.traceId ?? payload?.trace_id ?? payload?.request_id,
        }, `HTTP_${status}`);
    } catch {
        // 不保存无法解析或被截断的原始响应，避免记录 HTML、图片或请求回显。
        return safeError({ code: `HTTP_${status}`, message: `上游返回 HTTP ${status}` });
    }
}

function cleanRecord(item) {
    const record = {
        id: redact(item.id, 128),
        time: redact(item.time, 64),
        method: redact(item.method, 16),
        target: safeTarget(item.target),
        status: Number.isInteger(item.status) ? item.status : null,
        durationMs: Number.isFinite(item.durationMs) ? Math.max(0, Math.round(item.durationMs)) : 0,
        state: ["pending", "streaming", "success", "error", "cancelled"].includes(item.state) ? item.state : "error",
        model: redact(item.model, 128),
    };
    if (item.headersAt) record.headersAt = redact(item.headersAt, 64);
    if (item.endedAt) record.endedAt = redact(item.endedAt, 64);
    if (item.error) record.error = safeError(item.error);
    return record;
}

export function createRequestLog() {
    const file = resolve(process.env.CANVAS_REQUEST_LOG_FILE || fileURLToPath(new URL("../logs/request-log.jsonl", import.meta.url)));
    const maxBytes = envNumber("CANVAS_REQUEST_LOG_MAX_BYTES", 10 * 1024 * 1024, 16384, 100 * 1024 * 1024);
    const backups = envNumber("CANVAS_REQUEST_LOG_BACKUPS", 3, 1, 20);
    let items = new Map();
    let size = 0;
    const pending = new Map();
    let writing = false;
    const remember = (record) => {
        items.set(record.id, record);
        while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
    };
    const ready = (async () => {
        const restored = new Map();
        for (let index = backups; index >= 0; index--) {
            const path = index ? `${file}.${index}` : file;
            try {
                await chmod(path, 0o600);
                const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
                for await (const line of lines) {
                    try {
                        const record = cleanRecord(JSON.parse(line));
                        if (!record.id) continue;
                        restored.set(record.id, record);
                        while (restored.size > MAX_ITEMS) restored.delete(restored.keys().next().value);
                    } catch {
                        // 忽略退出时未写完的行。
                    }
                }
            } catch {
                // 文件不存在或不可读时仍可代理请求。
            }
        }
        for (const record of restored.values()) {
            if (["pending", "streaming"].includes(record.state)) {
                record.state = "error";
                record.error = safeError({ code: "PROXY_RESTART", message: "代理重启前请求未结束" });
            }
        }
        for (const [id, record] of items) restored.set(id, record);
        items = restored;
        while (items.size > MAX_ITEMS) items.delete(items.keys().next().value);
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const handle = await open(file, "a", 0o600);
        try {
            await handle.chmod(0o600);
            size = (await handle.stat()).size;
        } finally {
            await handle.close();
        }
    })().catch(() => {});
    async function flush() {
        writing = true;
        try {
            await ready;
            while (pending.size) {
                const [id, record] = pending.entries().next().value;
                pending.delete(id);
                const line = `${JSON.stringify(record)}\n`;
                try {
                    if (size + Buffer.byteLength(line) > maxBytes) {
                        await rm(`${file}.${backups}`, { force: true });
                        for (let index = backups - 1; index >= 0; index--) {
                            try {
                                await rename(index ? `${file}.${index}` : file, `${file}.${index + 1}`);
                            } catch (error) {
                                if (error.code !== "ENOENT") throw error;
                            }
                        }
                        size = 0;
                    }
                    const handle = await open(file, "a", 0o600);
                    try {
                        await handle.chmod(0o600);
                        size = (await handle.stat()).size;
                        await handle.writeFile(line);
                        size += Buffer.byteLength(line);
                    } finally {
                        await handle.close();
                    }
                } catch {
                    // 单条写入失败后仍处理后续日志。
                }
            }
        } finally {
            writing = false;
        }
    }

    function save(item) {
        try {
            const record = cleanRecord(item);
            remember(record);
            // 同一请求只排队最新状态；拥塞时淘汰最旧项，优先保留最近请求的结束记录。
            pending.set(record.id, record);
            while (pending.size > MAX_ITEMS) pending.delete(pending.keys().next().value);
            if (!writing) void flush().catch(() => {});
        } catch {
            // 日志异常不得影响请求。
        }
    }

    return {
        start(method, target) {
            const record = { id: randomUUID(), time: new Date().toISOString(), method, target: safeTarget(target), status: null, durationMs: 0, state: "pending", model: "" };
            save(record);
            return record;
        },
        save,
        async query(params) {
            await ready;
            const bounded = (name, fallback, max) => {
                const raw = params.get(name);
                const value = raw === null ? fallback : Number(raw);
                return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
            };
            const limit = bounded("limit", 100, MAX_ITEMS);
            const offset = bounded("offset", 0, MAX_ITEMS);
            const status = params.get("status") || "";
            const state = params.get("state") || "";
            const q = (params.get("q") || "").slice(0, 1024).toLowerCase();
            const matched = Array.from(items.values()).reverse().filter((item) =>
                (!status || (status === "error" ? item.state === "error" || item.state === "cancelled" || item.status >= 400 : status === "success" ? item.state === "success" : String(item.status) === status)) &&
                (!state || item.state === state) &&
                (!q || JSON.stringify(item).toLowerCase().includes(q)));
            return { items: matched.slice(offset, offset + limit), total: matched.length };
        },
    };
}

export function readRuntime() {
    return new Promise((resolve) => {
        const result = { services: SERVICES, scope: "仅 infinite-canvas-web 和 infinite-canvas-proxy 两个服务", items: [], total: 0 };
        let output = "";
        let bytes = 0;
        let settled = false;
        let timer;
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) result.error = safeError(error, "JOURNALCTL_FAILED");
            result.total = result.items.length;
            resolve(result);
        };
        const child = spawn("journalctl", ["-u", SERVICES[0], "-u", SERVICES[1], "-n", "100", "-o", "json", "--no-pager"], { stdio: ["ignore", "pipe", "ignore"], shell: false });
        const consume = (line) => {
            try {
                const entry = JSON.parse(line);
                if (!SERVICES.some((service) => entry._SYSTEMD_UNIT === `${service}.service`)) return;
                // 仅输出固定元数据与脱敏消息，不暴露 journal 的其他字段。
                result.items.push({ service: entry._SYSTEMD_UNIT, time: redact(entry.__REALTIME_TIMESTAMP, 64), priority: redact(entry.PRIORITY, 16), message: redact(entry.MESSAGE, 2048) });
                if (result.items.length > 100) result.items.shift();
            } catch {}
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            if (settled) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > 1024 * 1024) {
                child.kill();
                finish({ code: "RUNTIME_LIMIT", message: "服务日志输出超过读取上限" });
                return;
            }
            output += chunk.toString("utf8");
            let newline;
            while ((newline = output.indexOf("\n")) >= 0) {
                consume(output.slice(0, newline));
                output = output.slice(newline + 1);
            }
        });
        child.on("error", finish);
        child.on("close", (code) => {
            if (output) consume(output);
            finish(code === 0 ? undefined : { code: "JOURNALCTL_FAILED", message: `journalctl 退出状态 ${code}` });
        });
        timer = setTimeout(() => {
            child.kill();
            finish({ code: "RUNTIME_TIMEOUT", message: "读取服务日志超时" });
        }, 5000);
    });
}
