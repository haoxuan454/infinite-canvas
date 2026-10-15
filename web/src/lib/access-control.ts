// 阶段D 访问控制：设备指纹 / 请求头注入（axios + fetch）/ 401 友好提示 / 自定义渠道上报（不可变台账）。
import axios from "axios";

import { CONFIG_STORE_KEY } from "@/stores/use-config-store";

const FINGERPRINT_STORAGE_KEY = "infinite-canvas:device_fingerprint";
const REPORT_DEDUPE_KEY = "infinite-canvas:channel_reported";
const AUTH_ERROR_EVENT = "canvas:auth-error";

let cachedFingerprint = "";

function stableHash(text: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function collectFingerprintSignals() {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const parts = [
        navigator.userAgent,
        navigator.language,
        (navigator.languages || []).join(","),
        `${screen.width}x${screen.height}x${screen.colorDepth}`,
        String(new Date().getTimezoneOffset()),
        String(navigator.hardwareConcurrency || 0),
        String(nav.deviceMemory || 0),
    ];
    try {
        const canvas = document.createElement("canvas");
        canvas.width = 220;
        canvas.height = 40;
        const ctx = canvas.getContext("2d");
        if (ctx) {
            ctx.textBaseline = "top";
            ctx.font = "16px 'Arial'";
            ctx.fillStyle = "#f60";
            ctx.fillRect(0, 0, 100, 20);
            ctx.fillStyle = "#0af";
            ctx.fillText("infinite-canvas-fp", 2, 12);
            parts.push(canvas.toDataURL().slice(-96));
        }
    } catch {
        // canvas 指纹失败不阻塞
    }
    return parts.join("|");
}

/** 稳定设备指纹：同浏览器保持不变，用于设备绑定与台账。 */
export function getDeviceFingerprint() {
    if (cachedFingerprint) return cachedFingerprint;
    try {
        const stored = localStorage.getItem(FINGERPRINT_STORAGE_KEY);
        if (stored) {
            cachedFingerprint = stored;
            return stored;
        }
    } catch {}
    const fingerprint = `dvc-${stableHash(collectFingerprintSignals())}${stableHash(String(Date.now() ^ performance.now())).padStart(6, "0")}`;
    try {
        localStorage.setItem(FINGERPRINT_STORAGE_KEY, fingerprint);
    } catch {}
    cachedFingerprint = fingerprint;
    return fingerprint;
}

type PersistedConfig = { state?: { config?: { accessKey?: string } } };

function readAccessKey() {
    try {
        const raw = localStorage.getItem(CONFIG_STORE_KEY);
        if (!raw) return "";
        return (JSON.parse(raw) as PersistedConfig)?.state?.config?.accessKey || "";
    } catch {
        return "";
    }
}

/** 代理/上报请求统一携带的鉴权头。 */
export function accessAuthHeaders(): Record<string, string> {
    const accessKey = readAccessKey();
    return {
        ...(accessKey ? { "x-access-key": accessKey } : {}),
        "x-device-id": getDeviceFingerprint(),
    };
}

const AUTH_ERROR_CODES = new Set(["KEY_REQUIRED", "KEY_INVALID", "KEY_REVOKED", "KEY_EXPIRED", "DEVICE_REQUIRED", "DEVICE_LIMIT", "DEVICE_BLOCKED"]);

let lastAuthNoticeAt = 0;

function notifyAuthError(payload: { code?: string; error?: string }) {
    const now = Date.now();
    if (now - lastAuthNoticeAt < 3000) return;
    lastAuthNoticeAt = now;
    window.dispatchEvent(new CustomEvent(AUTH_ERROR_EVENT, { detail: payload }));
}

/** axios 请求拦截注入（应用启动时调用一次）：仅对同源代理路径注入，避免把访问密钥发给第三方 API。 */
export function installAccessControl() {
    axios.interceptors.request.use((config) => {
        const url = config.url || "";
        if (url.startsWith("/canvas-api/") || url === "/canvas-api" || url.includes("/canvas-api/https:")) {
            for (const [key, value] of Object.entries(accessAuthHeaders())) config.headers.set(key, value);
        }
        return config;
    });
    axios.interceptors.response.use(
        (response) => response,
        (error) => {
            const data = error?.response?.data;
            if (data && AUTH_ERROR_CODES.has(data.code)) notifyAuthError({ code: data.code, error: data.error });
            return Promise.reject(error);
        },
    );
}

/** fetch 调用点使用的鉴权头（与 axios 同源）。 */
export function withAuthHeaders(extra?: HeadersInit): HeadersInit {
    return { ...(extra as Record<string, string> | undefined), ...accessAuthHeaders() };
}

/**
 * 仅当请求经本项目同源代理（/canvas-api/...）时才附加访问鉴权头；
 * 直连第三方上游的请求绝不携带，防止访问 Key / 设备指纹外泄。
 */
export function authHeadersIfProxied(url: string): Record<string, string> {
    return url.startsWith("/canvas-api/") || url.includes("/canvas-api/https:") ? accessAuthHeaders() : {};
}

export function onAuthError(handler: (payload: { code?: string; error?: string }) => void) {
    const listener = (event: Event) => handler((event as CustomEvent).detail || {});
    window.addEventListener(AUTH_ERROR_EVENT, listener);
    return () => window.removeEventListener(AUTH_ERROR_EVENT, listener);
}

// ---------- 全屏密钥门：只读探测（GET /auth/verify，不产生设备绑定副作用） ----------

export type AccessVerifyResult = {
    enforcement: boolean;
    valid: boolean;
    code?: string;
    keyName?: string;
    expiresAt?: number | null;
    pendingBind?: boolean;
};

/** 调用代理端 /auth/verify 校验当前（或 override）密钥。override 用于门内提交时先验后存。 */
export async function verifyAccessKey(overrideKey?: string): Promise<AccessVerifyResult> {
    const headers = overrideKey
        ? { "x-access-key": overrideKey, "x-device-id": getDeviceFingerprint() }
        : accessAuthHeaders();
    const response = await fetch("/auth/verify", { headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`verify http ${response.status}`);
    return (await response.json()) as AccessVerifyResult;
}

// ---------- 进门即登记设备（POST /auth/bind：真实 authenticate，含 maxDevices 校验） ----------

const BIND_MARKER_KEY = "infinite-canvas:device_bound";

function bindMarkerValue(effectiveKey: string) {
    return `${getDeviceFingerprint()}|${stableHash(effectiveKey)}`;
}

function readBindMarker() {
    try {
        return localStorage.getItem(BIND_MARKER_KEY) || "";
    } catch {
        return "";
    }
}

function rememberBound(effectiveKey: string) {
    try {
        localStorage.setItem(BIND_MARKER_KEY, bindMarkerValue(effectiveKey));
    } catch {}
}

/** 当前设备+Key 组合是否已在本会话登记过（登记幂等，标记仅用于避免重复请求）。 */
export function isDeviceBound() {
    return readBindMarker() === bindMarkerValue(readAccessKey());
}

export type BindResult = { ok: boolean; code?: string; error?: string; bootstrap?: boolean };

/**
 * 调用代理端 /auth/bind 完成设备登记（设备台账立即可见）。
 * overrideKey 用于门内提交场景（Key 尚未落库时显式传入）。
 * 失败（Key 失效 / 设备超限 / 设备被禁）返回 ok:false + code，由密钥门决定拉回。
 */
export async function bindDevice(overrideKey?: string): Promise<BindResult> {
    const effectiveKey = overrideKey ?? readAccessKey();
    const headers = {
        "content-type": "application/json",
        ...(effectiveKey ? { "x-access-key": effectiveKey } : {}),
        "x-device-id": getDeviceFingerprint(),
    };
    const response = await fetch("/auth/bind", {
        method: "POST",
        headers,
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
    });
    let payload: { ok?: boolean; code?: string; error?: string; bootstrap?: boolean } = {};
    try {
        payload = (await response.json()) as { ok?: boolean; code?: string; error?: string; bootstrap?: boolean };
    } catch {
        payload = {};
    }
    if (!response.ok) return { ok: false, code: payload.code, error: payload.error };
    rememberBound(effectiveKey);
    return { ok: true, bootstrap: payload.bootstrap };
}

// ---------- 自定义渠道上报（记录不可变，仅管理员可删） ----------

function readReportedSet() {
    try {
        return new Set<string>(JSON.parse(localStorage.getItem(REPORT_DEDUPE_KEY) || "[]") as string[]);
    } catch {
        return new Set<string>();
    }
}

function rememberReported(token: string) {
    try {
        const next = readReportedSet();
        next.add(token);
        localStorage.setItem(REPORT_DEDUPE_KEY, JSON.stringify([...next].slice(-200)));
    } catch {}
}

export function channelReportToken(baseUrl: string, apiKey: string) {
    return `${baseUrl}|${stableHash(apiKey)}`;
}

/** 保存渠道时若填写了 apiKey，则上报明文台账（fire-and-forget；同 baseUrl+Key 只报一次）。 */
export function reportChannelUsage(payload: { baseUrl: string; apiKey: string; model?: string }) {
    const baseUrl = payload.baseUrl?.trim();
    const apiKey = payload.apiKey?.trim();
    if (!baseUrl || !apiKey || !/^https?:\/\//i.test(baseUrl)) return;
    const token = channelReportToken(baseUrl, apiKey);
    if (readReportedSet().has(token)) return;
    void fetch("/canvas-api/report-channel", {
        method: "POST",
        headers: { "content-type": "application/json", ...accessAuthHeaders() },
        body: JSON.stringify({ baseUrl, apiKey, model: payload.model || "" }),
    })
        .then((response) => {
            if (response.ok) rememberReported(token);
        })
        .catch(() => {
            // 上报失败静默：下次保存会重试
        });
}
