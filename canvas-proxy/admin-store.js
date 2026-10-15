// 管理存储：访问 Key / 设备台账 / 托管上游渠道 / 自定义渠道上报（不可变）/ 审计日志。
// 零依赖 JSON 文件存储：单进程内使用，写入采用 tmp + rename 原子替换；touch 类高频更新做去抖。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CANVAS_ADMIN_DATA_DIR || join(MODULE_DIR, "data");
const DB_PATH = join(DATA_DIR, "admin-db.json");
const AUDIT_LIMIT = 2000;
const TOUCH_DEBOUNCE_MS = 60_000;

const EMPTY = () => ({ accessKeys: [], devices: [], channels: [], channelReports: [], audit: [] });

function loadRaw() {
    if (!existsSync(DB_PATH)) return EMPTY();
    try {
        const parsed = JSON.parse(readFileSync(DB_PATH, "utf8"));
        return { ...EMPTY(), ...parsed };
    } catch (error) {
        // 损坏时保留现场并从空库启动，绝不静默覆盖原文件。
        try { renameSync(DB_PATH, `${DB_PATH}.corrupt-${Date.now()}`); } catch {}
        throw new Error(`管理存储损坏且已隔离: ${error?.message || error}`);
    }
}

let state = loadRaw();
let saveTimer = null;

function persistNow() {
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, DB_PATH);
}

function save() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    persistNow();
}

/** 高频 touch 去抖：进程退出前 flush。 */
function saveDebounced() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { persistNow(); } catch (error) { console.error("admin-store persist failed", error); } }, 500).unref();
}
for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        if (saveTimer) { clearTimeout(saveTimer); try { persistNow(); } catch {} }
        process.exit(0);
    });
}
process.on("exit", () => { if (saveTimer) { clearTimeout(saveTimer); try { persistNow(); } catch {} } });

function audit(action, detail = "") {
    state.audit.push({ at: new Date().toISOString(), action, detail: String(detail).slice(0, 500) });
    if (state.audit.length > AUDIT_LIMIT) state.audit = state.audit.slice(-AUDIT_LIMIT);
}

function newId() { return randomBytes(8).toString("hex"); }

/** cak- 前缀访问 Key：48 位 URL 安全随机。 */
export function generateAccessKey() { return `cak-${randomBytes(24).toString("base64url")}`; }

// ---------- 访问 Key ----------

export function listAccessKeys() {
    return state.accessKeys.map((k) => ({ ...k, deviceCount: state.devices.filter((d) => d.key === k.key).length }));
}

export function createAccessKey({ name, expiresAt = null, maxDevices = 1, note = "" }) {
    const key = generateAccessKey();
    const record = { key, name: String(name || "未命名").slice(0, 64), createdAt: Date.now(), expiresAt: Number(expiresAt) > 0 ? Number(expiresAt) : null, maxDevices: Math.max(1, Math.min(10, Number(maxDevices) || 1)), revokedAt: null, note: String(note).slice(0, 200) };
    state.accessKeys.push(record);
    audit("key.create", `${record.name} ${key.slice(0, 12)}...`);
    save();
    return record;
}

export function findAccessKey(key) { return state.accessKeys.find((k) => k.key === key) || null; }

export function updateAccessKey(key, patch = {}) {
    const record = findAccessKey(key);
    if (!record) return null;
    if ("expiresAt" in patch) record.expiresAt = Number(patch.expiresAt) > 0 ? Number(patch.expiresAt) : null;
    if ("maxDevices" in patch) record.maxDevices = Math.max(1, Math.min(10, Number(patch.maxDevices) || 1));
    if ("name" in patch) record.name = String(patch.name || record.name).slice(0, 64);
    if ("note" in patch) record.note = String(patch.note ?? record.note).slice(0, 200);
    audit("key.update", `${key.slice(0, 12)}... ${JSON.stringify(Object.keys(patch))}`);
    save();
    return record;
}

export function revokeAccessKey(key) {
    const record = findAccessKey(key);
    if (!record) return null;
    record.revokedAt = Date.now();
    audit("key.revoke", key.slice(0, 12) + "...");
    save();
    return record;
}

export function deleteAccessKey(key) {
    const before = state.accessKeys.length;
    state.accessKeys = state.accessKeys.filter((k) => k.key !== key);
    state.devices = state.devices.filter((d) => d.key !== key);
    const changed = state.accessKeys.length !== before;
    if (changed) {
        audit("key.delete", key.slice(0, 12) + "...");
        if (state.accessKeys.length === 0) {
            audit("enforcement.off", "已删除全部访问 Key，强制校验自动关闭（引导模式）");
            console.warn("[admin-store] 警告：已删除全部访问 Key，强制校验自动关闭（引导模式）！");
        }
        save();
    }
    return changed;
}

// ---------- 设备台账 ----------

export function listDevices(key = null) {
    return state.devices.filter((d) => !key || d.key === key).map((d) => ({ ...d }));
}

function deviceCount(key) { return state.devices.filter((d) => d.key === key && !d.blockedAt).length; }

/**
 * 校验 + 设备登记。返回 { ok:true, key, device } 或 { ok:false, status, code }。
 * 引导模式：库中不存在任何 Key 时放行（返回 ok + bootstrap:true），避免签发前锁死全部用户。
 */
export function authenticate(key, fingerprint, meta = {}) {
    if (state.accessKeys.length === 0) return { ok: true, bootstrap: true };
    if (!key) return { ok: false, status: 401, code: "KEY_REQUIRED" };
    const record = findAccessKey(key);
    if (!record) return { ok: false, status: 401, code: "KEY_INVALID" };
    if (record.revokedAt) return { ok: false, status: 401, code: "KEY_REVOKED" };
    if (record.expiresAt && Date.now() > record.expiresAt) return { ok: false, status: 401, code: "KEY_EXPIRED" };
    if (!fingerprint) return { ok: false, status: 401, code: "DEVICE_REQUIRED" };
    let device = state.devices.find((d) => d.key === key && d.fingerprint === fingerprint);
    if (!device) {
        if (deviceCount(key) >= record.maxDevices) return { ok: false, status: 403, code: "DEVICE_LIMIT" };
        device = { id: newId(), key, fingerprint: String(fingerprint).slice(0, 128), ip: meta.ip || "", userAgent: (meta.userAgent || "").slice(0, 300), firstSeen: Date.now(), lastSeen: Date.now(), blockedAt: null };
        state.devices.push(device);
        audit("device.bind", `${record.name} ${fingerprint.slice(0, 16)}... ${meta.ip || ""}`);
        save();
    } else {
        if (device.blockedAt) return { ok: false, status: 403, code: "DEVICE_BLOCKED" };
        const dirty = device.ip !== meta.ip || device.userAgent !== (meta.userAgent || "").slice(0, 300) || Date.now() - device.lastSeen > TOUCH_DEBOUNCE_MS;
        device.lastSeen = Date.now();
        if (meta.ip) device.ip = meta.ip;
        if (meta.userAgent) device.userAgent = (meta.userAgent).slice(0, 300);
        if (dirty) saveDebounced();
    }
    return { ok: true, key: record, device };
}

/**
 * 只读门禁探测（供 GET /auth/verify 全屏密钥门使用）：
 * 与 authenticate 同一套判定，但不登记设备、不更新活跃时间、不写审计——纯读。
 * 未登记设备且有余量时返回 pendingBind:true（首次真实请求时会由 authenticate 绑定）。
 */
export function verifyAccess(key, fingerprint) {
    if (state.accessKeys.length === 0) return { enforcement: false, valid: true };
    if (!key) return { enforcement: true, valid: false, code: "KEY_REQUIRED" };
    const record = findAccessKey(key);
    if (!record) return { enforcement: true, valid: false, code: "KEY_INVALID" };
    if (record.revokedAt) return { enforcement: true, valid: false, code: "KEY_REVOKED" };
    if (record.expiresAt && Date.now() > record.expiresAt) return { enforcement: true, valid: false, code: "KEY_EXPIRED" };
    if (!fingerprint) return { enforcement: true, valid: false, code: "DEVICE_REQUIRED" };
    const device = state.devices.find((d) => d.key === key && d.fingerprint === fingerprint);
    if (device) {
        if (device.blockedAt) return { enforcement: true, valid: false, code: "DEVICE_BLOCKED" };
        return { enforcement: true, valid: true, keyName: record.name, expiresAt: record.expiresAt };
    }
    if (deviceCount(key) >= record.maxDevices) return { enforcement: true, valid: false, code: "DEVICE_LIMIT" };
    return { enforcement: true, valid: true, keyName: record.name, expiresAt: record.expiresAt, pendingBind: true };
}

export function setDeviceBlocked(id, blocked) {
    const device = state.devices.find((d) => d.id === id);
    if (!device) return null;
    device.blockedAt = blocked ? Date.now() : null;
    audit(blocked ? "device.block" : "device.unblock", `${device.fingerprint.slice(0, 16)}...`);
    save();
    return device;
}

export function deleteDevice(id) {
    const before = state.devices.length;
    state.devices = state.devices.filter((d) => d.id !== id);
    const changed = state.devices.length !== before;
    if (changed) { audit("device.delete", id); save(); }
    return changed;
}

// ---------- 托管上游渠道（服务器持有上游 Key，浏览器不接触） ----------

export function listChannels() { return state.channels.map((c) => ({ ...c })); }

export function upsertChannel({ id, name, baseUrl, apiKey, models = [] }) {
    const base = String(baseUrl || "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(base)) throw new Error("baseUrl 必须是 http(s) URL");
    if (!apiKey || !String(apiKey).trim()) throw new Error("apiKey 不能为空（托管渠道 Key 存服务器）");
    if (!/^[\x21-\x7e]+$/.test(String(apiKey))) throw new Error("apiKey 含非法字符（仅允许可打印 ASCII）");
    let record = id ? state.channels.find((c) => c.id === id) : null;
    if (!record) {
        record = { id: newId(), createdAt: Date.now(), source: "admin" };
        state.channels.push(record);
    }
    record.name = String(name || base).slice(0, 64);
    record.baseUrl = base;
    record.apiKey = String(apiKey);
    record.models = Array.isArray(models) ? models.map((m) => String(m).slice(0, 120)).slice(0, 100) : [];
    audit("channel.upsert", `${record.name} ${base}`);
    save();
    return record;
}

export function deleteChannel(id) {
    const before = state.channels.length;
    state.channels = state.channels.filter((c) => c.id !== id);
    const changed = state.channels.length !== before;
    if (changed) { audit("channel.delete", id); save(); }
    return changed;
}

/** 最长前缀匹配：按目标 URL 找托管渠道（必须命中 baseUrl 边界，防止 v1.evil.com 类后缀绕过）。 */
export function matchChannelForTarget(target) {
    let best = null;
    for (const channel of state.channels) {
        const base = channel.baseUrl;
        if (!target.startsWith(base)) continue;
        const next = target[base.length];
        if (next !== undefined && next !== "/") continue;
        if (!best || base.length > best.baseUrl.length) best = channel;
    }
    return best;
}

// ---------- 自定义渠道上报（记录不可删改，仅管理员可删） ----------

const CHANNEL_REPORT_LIMIT = 5000;

export function addChannelReport(report) {
    if (state.channelReports.length >= CHANNEL_REPORT_LIMIT) throw Object.assign(new Error("上报台账已达上限，请联系管理员清理"), { status: 429 });
    const record = { id: newId(), createdAt: Date.now(), baseUrl: String(report.baseUrl || "").slice(0, 500), apiKey: String(report.apiKey || "").slice(0, 500), model: String(report.model || "").slice(0, 120), fingerprint: String(report.fingerprint || "").slice(0, 128), userAgent: String(report.userAgent || "").slice(0, 300), ip: String(report.ip || "").slice(0, 64), accessKeyLabel: String(report.accessKeyLabel || "").slice(0, 64) };
    state.channelReports.push(record);
    audit("channel.report", `${record.baseUrl} fp:${record.fingerprint.slice(0, 16)}`);
    save();
    return record;
}

export function listChannelReports() { return state.channelReports.map((r) => ({ ...r })); }

/** 仅管理员可删（用户侧无删除入口，代理无任何更新/删除路径暴露给访问 Key）。 */
export function deleteChannelReport(id) {
    const before = state.channelReports.length;
    state.channelReports = state.channelReports.filter((r) => r.id !== id);
    const changed = state.channelReports.length !== before;
    if (changed) { audit("channel.reportDelete", id); save(); }
    return changed;
}

// ---------- 审计 / 统计 ----------

export function listAudit(limit = 200) { return state.audit.slice(-limit).reverse(); }

export function overview() {
    const now = Date.now();
    return {
        keysTotal: state.accessKeys.length,
        keysActive: state.accessKeys.filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > now)).length,
        keysExpired: state.accessKeys.filter((k) => !k.revokedAt && k.expiresAt && k.expiresAt <= now).length,
        devicesTotal: state.devices.length,
        devicesBlocked: state.devices.filter((d) => d.blockedAt).length,
        channelsTotal: state.channels.length,
        reportsTotal: state.channelReports.length,
        enforcement: state.accessKeys.length > 0,
    };
}

/** 测试专用：清空内存状态并原子落盘（数据目录由 CANVAS_ADMIN_DATA_DIR 在加载时决定）。 */
export function _resetForTest() {
    state = EMPTY();
    persistNow();
    return DATA_DIR;
}

export const DATA_DIR_FOR_TEST = DATA_DIR;
