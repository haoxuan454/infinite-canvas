// 管理后台 API（/admin-api/*，x-admin-token 保护）+ 用户自定义渠道上报（/report-channel，访问 Key 保护）。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./admin-store.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TOKEN_PATH = process.env.CANVAS_ADMIN_TOKEN_FILE || join(MODULE_DIR, "data", "admin-token.txt");

function loadAdminToken() {
    if (process.env.CANVAS_ADMIN_TOKEN) return process.env.CANVAS_ADMIN_TOKEN;
    if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, "utf8").trim();
    const token = `cat-${randomBytes(24).toString("base64url")}`;
    mkdirSync(dirname(TOKEN_PATH), { recursive: true });
    writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
    try { chmodSync(TOKEN_PATH, 0o600); } catch {}
    console.log(`[admin-api] 已生成管理员令牌: ${TOKEN_PATH}`);
    return token;
}

let adminToken = loadAdminToken();
export function reloadAdminToken() { adminToken = loadAdminToken(); }

function tokenOk(candidate) {
    if (typeof candidate !== "string" || !candidate) return false;
    const a = createHash("sha256").update(candidate).digest();
    const b = createHash("sha256").update(adminToken).digest();
    return timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(payload));
}

function readBody(req, limit = 5 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > limit) {
                reject(Object.assign(new Error("请求体过大"), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
        req.on("aborted", () => reject(Object.assign(new Error("客户端取消请求"), { code: "CLIENT_ABORTED" })));
    });
}

/** 展示端掩码：管理列表不整串回显 Key/上游 Key，需要完整值的动作走专用接口。 */
function maskKey(value) {
    const text = String(value || "");
    return text.length > 12 ? `${text.slice(0, 8)}...${text.slice(-4)}` : "••••";
}

async function handleAdminRoute(req, res, sub) {
    const method = req.method || "GET";
    const json = async () => {
        const raw = await readBody(req);
        try { return raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 }); }
    };
    const seg = sub.split("/").filter(Boolean);
    // keys / devices / channels / reports / overview / audit / login
    if (method === "POST" && sub === "/login") return sendJson(res, 200, { ok: true });
    if (method === "GET" && sub === "/overview") return sendJson(res, 200, store.overview());
    if (method === "GET" && sub === "/keys") return sendJson(res, 200, { keys: store.listAccessKeys().map((k) => ({ ...k, keyMasked: maskKey(k.key), apiKeyHidden: true })) });
    if (method === "POST" && sub === "/keys") {
        const body = await json();
        const record = store.createAccessKey(body);
        // 仅创建响应返回完整 Key（此为唯一一次明文展示机会）。
        return sendJson(res, 200, { key: record });
    }
    if (seg[0] === "keys" && seg[1]) {
        const key = decodeURIComponent(seg[1]);
        if (method === "PATCH") {
            const body = await json();
            if (body.revoke) { const r = store.revokeAccessKey(key); if (!r) return sendJson(res, 404, { error: "Key 不存在" }); return sendJson(res, 200, { ok: true }); }
            const r = store.updateAccessKey(key, body);
            return r ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "Key 不存在" });
        }
        if (method === "DELETE") return sendJson(res, store.deleteAccessKey(key) ? 200 : 404, { ok: true });
    }
    if (method === "GET" && sub === "/devices") {
        const url = new URL(req.url, "http://localhost");
        return sendJson(res, 200, { devices: store.listDevices(url.searchParams.get("key")) });
    }
    if (seg[0] === "devices" && seg[1]) {
        const id = decodeURIComponent(seg[1]);
        if (method === "POST" && seg[2] === "block") { const r = store.setDeviceBlocked(id, true); return r ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "设备不存在" }); }
        if (method === "POST" && seg[2] === "unblock") { const r = store.setDeviceBlocked(id, false); return r ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "设备不存在" }); }
        if (method === "DELETE") return sendJson(res, store.deleteDevice(id) ? 200 : 404, { ok: true });
    }
    if (method === "GET" && sub === "/channels") return sendJson(res, 200, { channels: store.listChannels() });
    if (method === "POST" && sub === "/channels") {
        const body = await json();
        try { const record = store.upsertChannel(body); return sendJson(res, 200, { channel: record }); }
        catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    }
    if (method === "DELETE" && seg[0] === "channels" && seg[1]) return sendJson(res, store.deleteChannel(decodeURIComponent(seg[1])) ? 200 : 404, { ok: true });
    if (method === "GET" && sub === "/reports") return sendJson(res, 200, { reports: store.listChannelReports() });
    if (method === "DELETE" && seg[0] === "reports" && seg[1]) return sendJson(res, store.deleteChannelReport(decodeURIComponent(seg[1])) ? 200 : 404, { ok: true });
    if (method === "GET" && sub === "/audit") {
        const url = new URL(req.url, "http://localhost");
        return sendJson(res, 200, { audit: store.listAudit(Number(url.searchParams.get("limit")) || 200) });
    }
    return sendJson(res, 404, { error: "未知管理接口" });
}

/** /admin-api/* 入口：/login 免令牌（用于校验令牌本身），其余需 x-admin-token。 */
export async function handleAdminApi(req, res) {
    const sub = (req.url || "/").slice("/admin-api".length).split("?")[0] || "/";
    if (sub === "/login") {
        let body = {};
        try { body = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch {}
        if (!tokenOk(body.token)) return sendJson(res, 401, { error: "管理员令牌无效" });
        return sendJson(res, 200, { ok: true });
    }
    if (!tokenOk(req.headers["x-admin-token"])) return sendJson(res, 401, { error: "管理员令牌无效" });
    try {
        await handleAdminRoute(req, res, sub);
    } catch (error) {
        sendJson(res, error?.status || 500, { error: error?.message || "管理接口错误" });
    }
}

const AUTH_ERRORS = {
    KEY_REQUIRED: "缺少访问密钥：请在应用配置中填写管理员分配的访问密钥",
    KEY_INVALID: "访问密钥无效：请核对配置中的访问密钥",
    KEY_REVOKED: "访问密钥已被吊销：请联系管理员重新分配",
    KEY_EXPIRED: "访问密钥已过期：请联系管理员重新分配",
    DEVICE_REQUIRED: "缺少设备标识：请刷新页面后重试",
    DEVICE_LIMIT: "设备数量已达上限：请联系管理员解绑旧设备",
    DEVICE_BLOCKED: "当前设备已被管理员禁用：请联系管理员",
};

/** /report-channel：用户保存自定义渠道时上报（访问 Key 保护，记录不可变）。 */
export async function handleReportChannel(req, res) {
    if ((req.method || "") !== "POST") return sendJson(res, 405, { error: "只允许 POST" });
    const auth = store.authenticate(req.headers["x-access-key"], req.headers["x-device-id"], { ip: req.socket?.remoteAddress || "", userAgent: req.headers["user-agent"] || "" });
    if (!auth.ok) return sendJson(res, auth.status, { error: AUTH_ERRORS[auth.code] || "访问被拒绝", code: auth.code });
    let body = {};
    try { body = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch {}
    if (!/^https?:\/\//i.test(String(body.baseUrl || ""))) return sendJson(res, 400, { error: "baseUrl 不合法" });
    if (!String(body.apiKey || "").trim()) return sendJson(res, 400, { error: "apiKey 不能为空" });
    const record = store.addChannelReport({ ...body, ip: req.socket?.remoteAddress || "", userAgent: req.headers["user-agent"] || "", accessKeyLabel: auth.key?.name || "" });
    return sendJson(res, 200, { ok: true, id: record.id });
}

export { AUTH_ERRORS };
