// 管理后台（/admin）：访问 Key 签发与吊销 / 设备指纹台账 / 托管上游渠道 / 自定义渠道上报（不可变）/ 审计。
// 设计语言：Linear/Supabase 式数据密集仪表盘（参考 VoltAgent/awesome-design-md），layui 式后台组件形态，
// quark 式轻盈动效；密钥与指纹一律等宽字体；状态使用带圆点的胶囊 Tag。
import { Alert, App, Button, Card, DatePicker, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Table, Tabs, Tag, Typography } from "antd";
import dayjs, { type Dayjs } from "dayjs";
import { Activity, CheckCircle2, Copy, Fingerprint, KeyRound, Link2, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { MODEL_PROTOCOLS_BY_CAPABILITY } from "@/lib/model-protocol";

type AccessKey = { key: string; keyMasked: string; name: string; createdAt: number; expiresAt: number | null; maxDevices: number; revokedAt: number | null; note: string; deviceCount: number };
type Device = { id: string; key: string; fingerprint: string; ip: string; userAgent: string; firstSeen: number; lastSeen: number; blockedAt: number | null };
type ChannelModelEntry = { model: string; capability: "text" | "image" | "video" | "audio"; protocol: string; alias?: string };
type Channel = { id: string; name: string; baseUrl: string; apiKey: string; models: ChannelModelEntry[]; createdAt: number; source: string };
type Report = { id: string; baseUrl: string; apiKey: string; model: string; fingerprint: string; userAgent: string; ip: string; accessKeyLabel: string; createdAt: number };
type Overview = { keysTotal: number; keysActive: number; keysExpired: number; devicesTotal: number; devicesBlocked: number; channelsTotal: number; reportsTotal: number; enforcement: boolean };
type AuditEntry = { at: string; action: string; detail: string };

const TOKEN_STORAGE_KEY = "infinite-canvas:admin_token";

function authHeaders() {
    return { "content-type": "application/json", "x-admin-token": localStorage.getItem(TOKEN_STORAGE_KEY) || "" };
}

async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`/admin-api${path}`, { ...init, headers: authHeaders() });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
    return data as T;
}

function formatDate(value: number | string | null | undefined) {
    if (!value) return "-";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function relativeTime(value: number | null | undefined) {
    if (!value) return "-";
    const diff = Date.now() - value;
    if (diff < 60_000) return "<1m";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
}

/** 表格内长串（apiKey/baseUrl）中间省略展示；完整内容点击查看弹窗 + 一键复制。 */
function maskMiddle(value: string) {
    const s = String(value || "");
    if (s.length <= 16) return s;
    return `${s.slice(0, 10)}••••••${s.slice(-6)}`;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
    const { message } = App.useApp();
    return (
        <Button
            size="small"
            type="text"
            icon={<Copy className="size-3.5" />}
            onClick={() => {
                void navigator.clipboard.writeText(text).then(() => message.success(label || "已复制"));
            }}
        />
    );
}

function StatusDot({ tone }: { tone: "green" | "red" | "amber" | "gray" }) {
    const color = { green: "#10b981", red: "#ef4444", amber: "#f59e0b", gray: "#a8a29e" }[tone];
    return <span className="mr-1.5 inline-block size-1.5 rounded-full" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />;
}

// ---------- 精细有效期：相对时长（分钟级）/ 绝对时间（分钟级）/ 永久 ----------
type ExpiryMode = "relative" | "absolute" | "never";
type ExpiryUnit = "minutes" | "hours" | "days" | "weeks" | "months";
const EXPIRY_UNITS: { value: ExpiryUnit; labelKey: string; dayjsUnit: "minute" | "hour" | "day" | "week" | "month" }[] = [
    { value: "minutes", labelKey: "admin.keys.unitMinutes", dayjsUnit: "minute" },
    { value: "hours", labelKey: "admin.keys.unitHours", dayjsUnit: "hour" },
    { value: "days", labelKey: "admin.keys.unitDays", dayjsUnit: "day" },
    { value: "weeks", labelKey: "admin.keys.unitWeeks", dayjsUnit: "week" },
    { value: "months", labelKey: "admin.keys.unitMonths", dayjsUnit: "month" },
];
const QUICK_PRESETS: { amount: number; unit: ExpiryUnit; labelKey: string }[] = [
    { amount: 10, unit: "minutes", labelKey: "admin.keys.preset10min" },
    { amount: 1, unit: "hours", labelKey: "admin.keys.preset1hour" },
    { amount: 6, unit: "hours", labelKey: "admin.keys.preset6hour" },
    { amount: 1, unit: "days", labelKey: "admin.keys.preset1day" },
    { amount: 7, unit: "days", labelKey: "admin.keys.preset7day" },
    { amount: 30, unit: "days", labelKey: "admin.keys.preset30day" },
];
const MAX_EXPIRY_YEARS = 100;
/** 由数量+单位计算到期毫秒时间戳（dayjs 日历精确：跨月按日历月）；超界抛错防 Invalid Date→NaN→永久 Key。 */
const computeExpiry = (amount: number, unit: ExpiryUnit) => {
    const def = EXPIRY_UNITS.find((u) => u.value === unit);
    const expiresAt = dayjs().add(Math.max(1, Math.floor(amount)), def?.dayjsUnit || "minute").valueOf();
    if (!Number.isFinite(expiresAt) || expiresAt > Date.now() + MAX_EXPIRY_YEARS * 365 * 86_400_000) throw new Error("expiry_out_of_range");
    return expiresAt;
};
/** 剩余时间文案（页面 30s 心跳驱动刷新）。 */
function remainingText(expiresAt: number | null, now: number, labels: { never: string; expired: string; soon: string; day: string; hour: string; minute: string }) {
    if (!expiresAt) return labels.never;
    const diff = expiresAt - now;
    if (diff <= 0) return labels.expired;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return labels.soon;
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return `${labels.day.replace("{n}", String(days))}${hours > 0 ? labels.hour.replace("{n}", String(hours)) : ""}`;
    if (hours > 0) return `${labels.hour.replace("{n}", String(hours))}${mins > 0 ? labels.minute.replace("{n}", String(mins)) : ""}`;
    return labels.minute.replace("{n}", String(minutes));
}

/** 拉取模型后按名称推断默认能力（仅初始值，管理员可逐行修改）。 */
function guessModelCapability(name: string): ChannelModelEntry["capability"] {
    const n = name.toLowerCase();
    if (/(whisper|tts|speech|voice|audio|suno|fish-)/.test(n)) return "audio";
    if (/(video|sora|kling|runway|pika|veo|seedance|hailuo|luma|wan\d|pixverse|vidu)/.test(n)) return "video";
    if (/(seedream|dall|image|flux|sd3|stable-|midjourney|imagen|cogview|kolors|ideogram|recraft|grok-2-image)/.test(n)) return "image";
    return "text";
}

export default function AdminPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    // 托管渠道模型清单编辑：能力/协议选项复用用户侧同款 i18n。
    const channelCapabilityOptions = (["text", "image", "video", "audio"] as const).map((value) => ({ label: t(`config.channelEditor.capabilities.${value}`), value }));
    // 平台（托管分发）渠道第一期仅支持 Bearer 注入型协议：gemini 系（需 x-goog-api-key/key=）与 custom-script（需本地 Key）不开放。
    const MANAGED_EXCLUDED_PROTOCOLS = new Set(["gemini-image", "gemini-video", "custom-script"]);
    const channelProtocolOptions = (capability: string) => (MODEL_PROTOCOLS_BY_CAPABILITY[capability as keyof typeof MODEL_PROTOCOLS_BY_CAPABILITY] || []).filter((value) => !MANAGED_EXCLUDED_PROTOCOLS.has(value)).map((value) => ({ label: t(`config.channelEditor.modelProtocols.${value}`), value }));
    const [token, setToken] = useState<string>(() => localStorage.getItem(TOKEN_STORAGE_KEY) || "");
    const [authed, setAuthed] = useState(false);
    const [checking, setChecking] = useState(false);
    const [tokenDraft, setTokenDraft] = useState("");
    const [overview, setOverview] = useState<Overview | null>(null);
    const [keys, setKeys] = useState<AccessKey[]>([]);
    const [devices, setDevices] = useState<Device[]>([]);
    const [channels, setChannels] = useState<Channel[]>([]);
    const [reports, setReports] = useState<Report[]>([]);
    const [audit, setAudit] = useState<AuditEntry[]>([]);
    const [deviceKeyFilter, setDeviceKeyFilter] = useState<string>("");
    const [issueOpen, setIssueOpen] = useState(false);
    const [issuedKey, setIssuedKey] = useState<AccessKey | null>(null);
    const [channelEditor, setChannelEditor] = useState<Partial<Channel> | null>(null);
    const [fetchedModels, setFetchedModels] = useState<string[]>([]);
    const [fetchingModels, setFetchingModels] = useState(false);
    const [secretViewer, setSecretViewer] = useState<{ title: string; value: string } | null>(null);

    const refreshAll = useCallback(async () => {
        try {
            const [ov, k, d, c, r, a] = await Promise.all([
                adminFetch<Overview>("/overview"),
                adminFetch<{ keys: AccessKey[] }>("/keys"),
                adminFetch<{ devices: Device[] }>("/devices"),
                adminFetch<{ channels: Channel[] }>("/channels"),
                adminFetch<{ reports: Report[] }>("/reports"),
                adminFetch<{ audit: AuditEntry[] }>("/audit?limit=150"),
            ]);
            setOverview(ov); setKeys(k.keys); setDevices(d.devices); setChannels(c.channels); setReports(r.reports); setAudit(a.audit);
        } catch (error) {
            if ((error as { status?: number }).status === 401) { setAuthed(false); localStorage.removeItem(TOKEN_STORAGE_KEY); }
            else message.error((error as Error).message);
        }
    }, [message]);

    useEffect(() => {
        if (!token) return;
        setChecking(true);
        void adminFetch("/overview")
            .then(() => { setAuthed(true); return refreshAll(); })
            .catch(() => { setAuthed(false); localStorage.removeItem(TOKEN_STORAGE_KEY); })
            .finally(() => setChecking(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const login = async () => {
        const value = tokenDraft.trim();
        if (!value) return;
        setChecking(true);
        try {
            await fetch("/admin-api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: value }) }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error || "令牌无效"); });
            localStorage.setItem(TOKEN_STORAGE_KEY, value);
            setToken(value);
            setAuthed(true);
            await refreshAll();
        } catch (error) {
            message.error((error as Error).message);
        } finally {
            setChecking(false);
        }
    };

    // ---------- 密钥签发 ----------
    const [issueForm, setIssueForm] = useState<{ name: string; expiryMode: ExpiryMode; expiryAmount: number; expiryUnit: ExpiryUnit; expiryDate: Dayjs | null; maxDevices: number; note: string }>({ name: "", expiryMode: "relative", expiryAmount: 30, expiryUnit: "days", expiryDate: null, maxDevices: 1, note: "" });
    const issueKey = async () => {
        if (!issueForm.name.trim()) { message.warning(t("admin.keys.nameRequired")); return; }
        let expiresAt: number | null = null;
        try {
            if (issueForm.expiryMode === "relative") expiresAt = computeExpiry(issueForm.expiryAmount, issueForm.expiryUnit);
            else if (issueForm.expiryMode === "absolute") {
                if (!issueForm.expiryDate || issueForm.expiryDate.valueOf() <= Date.now()) { message.warning(t("admin.keys.expiryPast")); return; }
                expiresAt = issueForm.expiryDate.valueOf();
            }
        } catch {
            message.warning(t("admin.keys.expiryOutOfRange"));
            return;
        }
        try {
            const data = await adminFetch<{ key: AccessKey }>("/keys", { method: "POST", body: JSON.stringify({ name: issueForm.name.trim(), expiresAt, maxDevices: issueForm.maxDevices, note: issueForm.note }) });
            setIssuedKey(data.key);
            setIssueOpen(false);
        setIssueForm({ name: "", expiryMode: "relative", expiryAmount: 30, expiryUnit: "days", expiryDate: null, maxDevices: 1, note: "" });
        await refreshAll();
        } catch (e) {
            message.error((e as Error).message);
        }
    };

    const [nowTick, setNowTick] = useState(Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowTick(Date.now()), 30_000);
        return () => window.clearInterval(id);
    }, []);

    const revokeKey = (key: string) => adminFetch(`/keys/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ revoke: true }) }).then(refreshAll).catch((e) => message.error(e.message));
    const deleteKey = (key: string) => adminFetch(`/keys/${encodeURIComponent(key)}`, { method: "DELETE" }).then(refreshAll).catch((e) => message.error(e.message));
    const [renewTarget, setRenewTarget] = useState<AccessKey | null>(null);
    const [renewForm, setRenewForm] = useState<{ amount: number; unit: ExpiryUnit }>({ amount: 30, unit: "days" });
    const renewKey = async () => {
        if (!renewTarget) return;
        let expiresAt: number;
        try {
            expiresAt = computeExpiry(renewForm.amount, renewForm.unit);
        } catch {
            message.warning(t("admin.keys.expiryOutOfRange"));
            return;
        }
        await adminFetch(`/keys/${encodeURIComponent(renewTarget.key)}`, { method: "PATCH", body: JSON.stringify({ expiresAt }) }).then(() => { message.success(t("admin.keys.extended")); setRenewTarget(null); return refreshAll(); }).catch((e) => message.error(e.message));
    };

    const setDeviceBlocked = (id: string, blocked: boolean) => adminFetch(`/devices/${id}/${blocked ? "block" : "unblock"}`, { method: "POST" }).then(refreshAll).catch((e) => message.error(e.message));
    const deleteDevice = (id: string) => adminFetch(`/devices/${id}`, { method: "DELETE" }).then(refreshAll).catch((e) => message.error(e.message));
    const saveChannel = async () => {
        if (!channelEditor) return;
        try {
            await adminFetch("/channels", { method: "POST", body: JSON.stringify(channelEditor) });
            setChannelEditor(null);
            await refreshAll();
            message.success(t("common.saved"));
        } catch (error) { message.error((error as Error).message); }
    };
    const deleteChannel = (id: string) => adminFetch(`/channels/${id}`, { method: "DELETE" }).then(refreshAll).catch((e) => message.error(e.message));
    const deleteReport = (id: string) => adminFetch(`/reports/${id}`, { method: "DELETE" }).then(refreshAll).catch((e) => message.error(e.message));
    // 拉取上游渠道可用模型（服务端代拉，上游 Key 不出服务器边界），供多选分发。
    const fetchUpstreamModels = async () => {
        if (!channelEditor) return;
        const baseUrl = (channelEditor.baseUrl || "").trim();
        const apiKey = (channelEditor.apiKey || "").trim();
        if (!baseUrl || !apiKey) { message.warning(t("admin.channels.fetchNeedConn")); return; }
        setFetchingModels(true);
        try {
            const data = await adminFetch<{ models: string[] }>("/channels/fetch-models", { method: "POST", body: JSON.stringify({ baseUrl, apiKey }) });
            setFetchedModels(data.models || []);
            if ((data.models || []).length === 0) message.info(t("admin.channels.fetchEmpty"));
            else message.success(t("admin.channels.fetchDone", { n: data.models.length }));
        } catch (error) { message.error(`${t("admin.channels.fetchFailed")}：${(error as Error).message}`); }
        finally { setFetchingModels(false); }
    };
    const pickedFetched = (channelEditor?.models || []).filter((m) => fetchedModels.includes(m.model)).map((m) => m.model);
    // 多选勾选 → 结构化模型行（能力按名称推断、协议默认 auto、显示别名按能力自动编号，均可逐行修改）；不在清单内的手动行原样保留。
    const applyPickedModels = (selected: string[]) => {
        if (!channelEditor) return;
        const aliasLabels: Record<string, string> = { text: "文本", image: "生图", video: "视频", audio: "音频" };
        const counters: Record<string, number> = {};
        const manual = (channelEditor.models || []).filter((m) => m.model.trim() && !fetchedModels.includes(m.model));
        setChannelEditor({
            ...channelEditor,
            models: [
                ...selected.map((name) => {
                    const capability = guessModelCapability(name);
                    const label = aliasLabels[capability] || capability;
                    counters[capability] = (counters[capability] || 0) + 1;
                    return { model: name, capability, protocol: "auto", alias: `${label}-${counters[capability]}` };
                }),
                ...manual,
            ],
        });
    };

    const filteredDevices = useMemo(() => (deviceKeyFilter ? devices.filter((d) => d.key === deviceKeyFilter) : devices), [devices, deviceKeyFilter]);

    if (!authed) {
        return (
            <main className="grid min-h-full place-items-center bg-gradient-to-br from-stone-100 via-stone-50 to-emerald-50/40 p-6 dark:from-stone-950 dark:via-stone-900 dark:to-emerald-950/20">
                <Card className="w-full max-w-sm border-stone-200/80 shadow-xl shadow-stone-200/40 transition-all duration-300 hover:shadow-2xl dark:border-stone-800 dark:shadow-black/40" styles={{ body: { padding: 28 } }}>
                    <div className="mb-6 text-center">
                        <div className="mx-auto mb-3 grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25">
                            <ShieldCheck className="size-7" />
                        </div>
                        <h1 className="text-lg font-semibold">{t("admin.login.title")}</h1>
                        <p className="mt-1 text-xs text-stone-500">{t("admin.login.description")}</p>
                    </div>
                    <Space.Compact className="w-full">
                        <Input.Password value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder="cat-..." onPressEnter={() => void login()} autoComplete="new-password" />
                        <Button type="primary" loading={checking} onClick={() => void login()}>{t("admin.login.submit")}</Button>
                    </Space.Compact>
                </Card>
            </main>
        );
    }

    const keyStatus = (k: AccessKey): { tone: "green" | "red" | "amber"; label: string } => {
        if (k.revokedAt) return { tone: "red", label: t("admin.keys.revoked") };
        if (k.expiresAt && Date.now() > k.expiresAt) return { tone: "amber", label: t("admin.keys.expired") };
        return { tone: "green", label: t("admin.keys.active") };
    };

    const statCards = [
        { icon: KeyRound, label: t("admin.stats.keys"), value: `${overview?.keysActive ?? 0}/${overview?.keysTotal ?? 0}`, tone: "from-emerald-500 to-teal-600" },
        { icon: Fingerprint, label: t("admin.stats.devices"), value: `${overview?.devicesTotal ?? 0}${overview?.devicesBlocked ? ` (${t("admin.stats.blocked", { count: overview.devicesBlocked })})` : ""}`, tone: "from-sky-500 to-indigo-600" },
        { icon: Link2, label: t("admin.stats.channels"), value: String(overview?.channelsTotal ?? 0), tone: "from-violet-500 to-purple-600" },
        { icon: Activity, label: t("admin.stats.reports"), value: String(overview?.reportsTotal ?? 0), tone: "from-amber-500 to-orange-600" },
    ];

    return (
        <main className="min-h-full bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            <div className="mx-auto max-w-6xl space-y-5 p-5">
                {/* 头部 */}
                <header className="animate-in flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-stone-200 bg-gradient-to-r from-white to-emerald-50/50 p-5 shadow-sm transition-shadow hover:shadow-md dark:border-stone-800 dark:from-stone-900 dark:to-emerald-950/20">
                    <div className="flex items-center gap-3">
                        <div className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25">
                            <ShieldCheck className="size-6" />
                        </div>
                        <div>
                            <h1 className="text-lg font-semibold tracking-tight">{t("admin.title")}</h1>
                            <p className="text-xs text-stone-500">{t("admin.subtitle")}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {overview?.enforcement ? (
                            <Tag className="!m-0 !rounded-full !px-3" color="green" icon={<ShieldCheck className="size-3" />}>{t("admin.enforcementOn")}</Tag>
                        ) : (
                            <Tag className="!m-0 !rounded-full !px-3" color="gold" icon={<ShieldAlert className="size-3" />}>{t("admin.enforcementOff")}</Tag>
                        )}
                        <Button icon={<RefreshCw className="size-4" />} onClick={() => void refreshAll()}>{t("common.refresh")}</Button>
                    </div>
                </header>

                {!overview?.enforcement ? (
                    <Alert type="warning" showIcon icon={<TriangleAlert className="size-4" />} message={t("admin.bootstrapWarning")} className="!rounded-xl" />
                ) : null}

                {/* 统计卡片 */}
                <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                    {statCards.map((card) => (
                        <div key={card.label} className="group rounded-xl border border-stone-200 bg-white p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md dark:border-stone-800 dark:bg-stone-900">
                            <div className="flex items-center gap-3">
                                <div className={`grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${card.tone} text-white shadow-md transition-transform duration-300 group-hover:scale-110`}>
                                    <card.icon className="size-4" />
                                </div>
                                <div className="min-w-0">
                                    <div className="truncate font-mono text-xl font-semibold tracking-tight">{card.value}</div>
                                    <div className="truncate text-xs text-stone-500">{card.label}</div>
                                </div>
                            </div>
                        </div>
                    ))}
                </section>

                <Tabs
                    items={[
                        {
                            key: "keys",
                            label: <span className="inline-flex items-center gap-1.5"><KeyRound className="size-3.5" />{t("admin.tabs.keys")}</span>,
                            children: (
                                <div className="space-y-3">
                                    <div className="flex justify-end">
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setIssueOpen(true)}>{t("admin.keys.issue")}</Button>
                                    </div>
                                    <Table
                                        rowKey="key"
                                        dataSource={keys}
                                        size="small"
                                        pagination={false}
                                        className="[&_.ant-table]:!rounded-xl"
                                        columns={[
                                            { title: t("admin.keys.name"), dataIndex: "name", width: 140, render: (v: string) => <span className="font-medium">{v}</span> },
                                            { title: t("admin.keys.key"), dataIndex: "keyMasked", render: (v: string) => <span className="font-mono text-xs text-stone-500">{v}</span> },
                                            { title: t("admin.keys.status"), width: 110, render: (_: unknown, k: AccessKey) => { const s = keyStatus(k); return <Tag className="!rounded-full" color={s.tone === "green" ? "green" : s.tone === "amber" ? "gold" : "red"}><StatusDot tone={s.tone} />{s.label}</Tag>; } },
                                            { title: t("admin.keys.devices"), dataIndex: "deviceCount", width: 90, render: (_: unknown, k: AccessKey) => <span className="font-mono">{k.deviceCount}/{k.maxDevices}</span> },
                                            { title: t("admin.keys.expiresAt"), dataIndex: "expiresAt", width: 190, render: (v: number | null) => (
                                                <div className="leading-4">
                                                    <div className="font-mono text-xs">{v ? formatDate(v) : t("admin.keys.never")}</div>
                                                    <div className="text-[11px] text-stone-500">{remainingText(v, nowTick, { never: t("admin.keys.never"), expired: t("admin.keys.expiredAlready"), soon: t("admin.keys.remainingSoon"), day: t("admin.keys.remainingDays"), hour: t("admin.keys.remainingHours"), minute: t("admin.keys.remainingMinutes") })}</div>
                                                </div>
                                            ) },
                                            { title: t("admin.keys.lastSeen"), width: 90, render: (_: unknown, k: AccessKey) => { const ds = devices.filter((d) => d.key === k.key); const latest = ds.length ? Math.max(...ds.map((d) => d.lastSeen)) : 0; return <span className="font-mono text-xs text-stone-500">{latest ? relativeTime(latest) : "-"}</span>; } },
                                            {
                                                title: t("admin.keys.actions"),
                                                width: 220,
                                                render: (_: unknown, k: AccessKey) => (
                                                    <Space size={4}>
                                                        {!k.revokedAt ? <Button size="small" onClick={() => { setRenewForm({ amount: 30, unit: "days" }); setRenewTarget(k); }}>{t("admin.keys.renew")}</Button> : null}
                                                        {!k.revokedAt ? <Popconfirm title={t("admin.keys.revokeConfirm")} onConfirm={() => void revokeKey(k.key)}><Button size="small" danger>{t("admin.keys.revoke")}</Button></Popconfirm> : null}
                                                        <Popconfirm title={t("admin.keys.deleteConfirm")} onConfirm={() => void deleteKey(k.key)}><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} /></Popconfirm>
                                                    </Space>
                                                ),
                                            },
                                        ]}
                                    />
                                </div>
                            ),
                        },
                        {
                            key: "devices",
                            label: <span className="inline-flex items-center gap-1.5"><Fingerprint className="size-3.5" />{t("admin.tabs.devices")}</span>,
                            children: (
                                <div className="space-y-3">
                                    {/* Key 筛选下拉：Key 数量增长时不会横向溢出（原横排 Segmented 已废弃）。 */}
                                    <Select
                                        value={deviceKeyFilter}
                                        onChange={(v) => setDeviceKeyFilter(v)}
                                        showSearch
                                        optionFilterProp="label"
                                        className="!w-64"
                                        options={[{ value: "", label: t("admin.devices.all") }, ...keys.map((k) => ({ value: k.key, label: k.name }))]}
                                    />
                                    <Table
                                        rowKey="id"
                                        dataSource={filteredDevices}
                                        size="small"
                                        pagination={false}
                                        locale={{ emptyText: <Empty description={t("admin.devices.empty")} /> }}
                                        columns={[
                                            { title: t("admin.devices.belongKey"), dataIndex: "key", width: 140, render: (v: string) => <span className="text-xs">{keys.find((k) => k.key === v)?.name || <span className="font-mono text-stone-400">{v.slice(0, 12)}…</span>}</span> },
                                            { title: t("admin.devices.fingerprint"), dataIndex: "fingerprint", render: (v: string) => <span className="font-mono text-xs">{v.length > 20 ? `${v.slice(0, 20)}…` : v}</span> },
                                            { title: t("admin.devices.ip"), dataIndex: "ip", width: 140, render: (v: string) => <span className="font-mono text-xs">{v || "-"}</span> },
                                            { title: t("admin.devices.userAgent"), dataIndex: "userAgent", ellipsis: true, render: (v: string) => <span className="text-xs text-stone-500">{v || "-"}</span> },
                                            { title: t("admin.devices.firstSeen"), dataIndex: "firstSeen", width: 90, render: relativeTime },
                                            { title: t("admin.devices.lastSeen"), dataIndex: "lastSeen", width: 90, render: relativeTime },
                                            { title: t("admin.devices.status"), dataIndex: "blockedAt", width: 100, render: (v: number | null) => v ? <Tag className="!rounded-full" color="red"><StatusDot tone="red" />{t("admin.devices.blocked")}</Tag> : <Tag className="!rounded-full" color="green"><StatusDot tone="green" />{t("admin.devices.normal")}</Tag> },
                                            {
                                                title: t("admin.devices.actions"),
                                                width: 170,
                                                render: (_: unknown, d: Device) => (
                                                    <Space size={4}>
                                                        {d.blockedAt ? <Button size="small" onClick={() => void setDeviceBlocked(d.id, false)}>{t("admin.devices.unblock")}</Button> : <Button size="small" danger onClick={() => void setDeviceBlocked(d.id, true)}>{t("admin.devices.block")}</Button>}
                                                        <Popconfirm title={t("admin.devices.deleteConfirm")} description={t("admin.devices.deleteDescription")} onConfirm={() => void deleteDevice(d.id)}><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} /></Popconfirm>
                                                    </Space>
                                                ),
                                            },
                                        ]}
                                    />
                                </div>
                            ),
                        },
                        {
                            key: "channels",
                            label: <span className="inline-flex items-center gap-1.5"><Link2 className="size-3.5" />{t("admin.tabs.channels")}</span>,
                            children: (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-xs text-stone-500">{t("admin.channels.description")}</p>
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setChannelEditor({ name: "", baseUrl: "https://", apiKey: "", models: [] })}>{t("admin.channels.add")}</Button>
                                    </div>
                                    <Table
                                        rowKey="id"
                                        dataSource={channels}
                                        size="small"
                                        pagination={false}
                                        locale={{ emptyText: <Empty description={t("admin.channels.empty")} /> }}
                                        columns={[
                                            { title: t("admin.channels.name"), dataIndex: "name", width: 140 },
                                            { title: t("admin.channels.baseUrl"), dataIndex: "baseUrl", width: 220, render: (v: string) => (
                                                <button type="button" className="max-w-full truncate font-mono text-xs underline decoration-dotted underline-offset-2" title={t("admin.reports.viewHint")} onClick={() => setSecretViewer({ title: t("admin.channels.baseUrl"), value: v })}>
                                                    {maskMiddle(v)}
                                                </button>
                                            ) },
                                            { title: t("admin.channels.apiKey"), dataIndex: "apiKey", width: 220, render: (v: string) => (
                                                <Space size={4} className="max-w-full">
                                                    <button type="button" className="truncate font-mono text-xs text-rose-600 underline decoration-dotted underline-offset-2 dark:text-rose-400" title={t("admin.reports.viewHint")} onClick={() => setSecretViewer({ title: t("admin.channels.apiKey"), value: v })}>
                                                        {maskMiddle(v)}
                                                    </button>
                                                    <CopyButton text={v} />
                                                </Space>
                                            ) },
                                            { title: t("admin.channels.models"), dataIndex: "models", render: (v: ChannelModelEntry[]) => <span className="text-xs text-stone-500">{v?.length ? v.map((m) => `${m.alias || m.model}（${m.capability}${m.alias ? `，真实: ${m.model}` : ""}）`).join("、") : "-"}</span> },
                                            { title: t("admin.channels.createdAt"), dataIndex: "createdAt", width: 140, render: (v: number) => <span className="font-mono text-xs">{formatDate(v)}</span> },
                                            { title: t("admin.devices.actions"), width: 80, render: (_: unknown, c: Channel) => <Space size={4}><Button size="small" onClick={() => setChannelEditor(c)}>{t("common.edit")}</Button><Popconfirm title={t("admin.channels.deleteConfirm")} onConfirm={() => void deleteChannel(c.id)}><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} /></Popconfirm></Space> },
                                        ]}
                                    />
                                </div>
                            ),
                        },
                        {
                            key: "reports",
                            label: <span className="inline-flex items-center gap-1.5"><Activity className="size-3.5" />{t("admin.tabs.reports")}</span>,
                            children: (
                                <div className="space-y-3">
                                    <Alert type="info" showIcon message={t("admin.reports.notice")} className="!rounded-xl" />
                                    <Table
                                        rowKey="id"
                                        dataSource={reports}
                                        size="small"
                                        pagination={{ pageSize: 15, hideOnSinglePage: true }}
                                        locale={{ emptyText: <Empty description={t("admin.reports.empty")} /> }}
                                        columns={[
                                            { title: t("admin.reports.baseUrl"), dataIndex: "baseUrl", width: 220, render: (v: string) => (
                                                <button type="button" className="max-w-full truncate font-mono text-xs underline decoration-dotted underline-offset-2" title={t("admin.reports.viewHint")} onClick={() => setSecretViewer({ title: t("admin.reports.baseUrl"), value: v })}>
                                                    {maskMiddle(v)}
                                                </button>
                                            ) },
                                            { title: t("admin.reports.apiKey"), dataIndex: "apiKey", width: 220, render: (v: string) => (
                                                <Space size={4} className="max-w-full">
                                                    <button type="button" className="truncate font-mono text-xs text-rose-600 underline decoration-dotted underline-offset-2 dark:text-rose-400" title={t("admin.reports.viewHint")} onClick={() => setSecretViewer({ title: t("admin.reports.apiKey"), value: v })}>
                                                        {maskMiddle(v)}
                                                    </button>
                                                    <CopyButton text={v} />
                                                </Space>
                                            ) },
                                            { title: t("admin.reports.model"), dataIndex: "model", width: 160, ellipsis: true, render: (v: string) => <span className="text-xs">{v || "-"}</span> },
                                            { title: t("admin.devices.fingerprint"), dataIndex: "fingerprint", width: 130, render: (v: string) => <span className="font-mono text-xs text-stone-500">{v?.slice(0, 16)}…</span> },
                                            { title: t("admin.devices.ip"), dataIndex: "ip", width: 120, render: (v: string) => <span className="font-mono text-xs">{v || "-"}</span> },
                                            { title: t("admin.reports.by"), dataIndex: "accessKeyLabel", width: 110, render: (v: string) => <span className="text-xs">{v || "-"}</span> },
                                            { title: t("admin.reports.createdAt"), dataIndex: "createdAt", width: 140, render: (v: number) => <span className="font-mono text-xs">{formatDate(v)}</span> },
                                            { title: t("admin.devices.actions"), width: 80, render: (_: unknown, r: Report) => <Popconfirm title={t("admin.reports.deleteConfirm")} onConfirm={() => void deleteReport(r.id)}><Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} /></Popconfirm> },
                                        ]}
                                    />
                                </div>
                            ),
                        },
                        {
                            key: "audit",
                            label: t("admin.tabs.audit"),
                            children: (
                                <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
                                    <Typography.Paragraph className="!mb-3 text-xs text-stone-500">{t("admin.audit.description")}</Typography.Paragraph>
                                    {audit.length === 0 ? <Empty description={t("admin.audit.empty")} /> : (
                                        <ul className="space-y-1.5">
                                            {audit.map((entry, index) => (
                                                <li key={index} className="flex items-baseline gap-2 font-mono text-xs">
                                                    <span className="text-stone-400">{formatDate(entry.at)}</span>
                                                    <Tag className="!rounded-full !text-[10px]" color={entry.action.includes("delete") || entry.action.includes("block") ? "red" : entry.action.includes("report") ? "gold" : "blue"}>{entry.action}</Tag>
                                                    <span className="text-stone-600 dark:text-stone-300">{entry.detail}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            ),
                        },
                    ]}
                />
            </div>

            {/* 签发 Key */}
            <Modal open={issueOpen} title={<span className="inline-flex items-center gap-2"><KeyRound className="size-4 text-emerald-500" />{t("admin.keys.issue")}</span>} okText={t("admin.keys.issue")} cancelText={t("common.cancel")} onOk={() => void issueKey()} onCancel={() => setIssueOpen(false)} destroyOnClose>
                <div className="space-y-3 pt-2">
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t("admin.keys.formName")}</span>
                        <Input value={issueForm.name} onChange={(e) => setIssueForm({ ...issueForm, name: e.target.value })} placeholder={t("admin.keys.formNamePlaceholder")} />
                    </label>
                    <div>
                        <span className="mb-1 block text-sm font-medium">{t("admin.keys.formExpiry")}</span>
                        <div className="space-y-2">
                            <Segmented value={issueForm.expiryMode} onChange={(v) => setIssueForm({ ...issueForm, expiryMode: v as ExpiryMode })} options={[{ label: t("admin.keys.formExpiryRelative"), value: "relative" }, { label: t("admin.keys.formExpiryAbsolute"), value: "absolute" }, { label: t("admin.keys.formExpiryNever"), value: "never" }]} />
                            {issueForm.expiryMode === "relative" ? (
                                <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                        <InputNumber min={1} max={5_256_000} value={issueForm.expiryAmount} onChange={(v) => setIssueForm({ ...issueForm, expiryAmount: v || 1 })} className="w-28" />
                                        <Select value={issueForm.expiryUnit} onChange={(v) => setIssueForm({ ...issueForm, expiryUnit: v })} className="w-32" options={EXPIRY_UNITS.map((u) => ({ value: u.value, label: t(u.labelKey) }))} />
                                    </div>
                                    <div className="flex flex-wrap gap-1">
                                        {QUICK_PRESETS.map((preset) => <Button key={preset.labelKey} size="small" onClick={() => setIssueForm({ ...issueForm, expiryAmount: preset.amount, expiryUnit: preset.unit })}>{t(preset.labelKey)}</Button>)}
                                    </div>
                                    <span className="block text-xs text-stone-500">{t("admin.keys.formExpiryMinutesHint")}</span>
                                </div>
                            ) : null}
                            {issueForm.expiryMode === "absolute" ? (
                                <DatePicker
                                    showTime={{ format: "HH:mm" }}
                                    format="YYYY-MM-DD HH:mm"
                                    minuteStep={1}
                                    value={issueForm.expiryDate}
                                    onChange={(v) => setIssueForm({ ...issueForm, expiryDate: v })}
                                    className="!w-full"
                                    disabledDate={(d) => d.isBefore(dayjs().startOf("day"))}
                                />
                            ) : null}
                        </div>
                    </div>
                    <div>
                        <span className="mb-1 block text-sm font-medium">{t("admin.keys.formMaxDevices")}</span>
                        <InputNumber min={1} max={10} value={issueForm.maxDevices} onChange={(v) => setIssueForm({ ...issueForm, maxDevices: v || 1 })} />
                        <span className="ml-2 text-xs text-stone-500">{t("admin.keys.formMaxDevicesHint")}</span>
                    </div>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t("admin.keys.formNote")}</span>
                        <Input value={issueForm.note} onChange={(e) => setIssueForm({ ...issueForm, note: e.target.value })} />
                    </label>
                </div>
            </Modal>

            {/* 自定义续期：数量 + 单位（分钟级） */}
            <Modal open={Boolean(renewTarget)} title={<span className="inline-flex items-center gap-2"><KeyRound className="size-4 text-emerald-500" />{t("admin.keys.renewTitle")}{renewTarget?.name ? ` · ${renewTarget.name}` : ""}</span>} okText={t("admin.keys.renew")} cancelText={t("common.cancel")} onOk={() => void renewKey()} onCancel={() => setRenewTarget(null)} destroyOnClose>
                <div className="space-y-3 pt-2">
                    <div className="flex items-center gap-2">
                        <InputNumber min={1} max={5_256_000} value={renewForm.amount} onChange={(v) => setRenewForm({ ...renewForm, amount: v || 1 })} className="w-28" />
                        <Select value={renewForm.unit} onChange={(v) => setRenewForm({ ...renewForm, unit: v })} className="w-32" options={EXPIRY_UNITS.map((u) => ({ value: u.value, label: t(u.labelKey) }))} />
                    </div>
                    <div className="flex flex-wrap gap-1">
                        {QUICK_PRESETS.map((preset) => <Button key={preset.labelKey} size="small" onClick={() => setRenewForm({ amount: preset.amount, unit: preset.unit })}>{t(preset.labelKey)}</Button>)}
                    </div>
                    <span className="block text-xs text-stone-500">{t("admin.keys.renewHint")}</span>
                </div>
            </Modal>

            {/* 签发结果：唯一一次展示完整 Key */}
            <Modal open={Boolean(issuedKey)} footer={null} onCancel={() => setIssuedKey(null)} title={<span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-500" />{t("admin.keys.issuedTitle")}</span>}>
                <div className="space-y-3 pt-2">
                    <Alert type="warning" showIcon message={t("admin.keys.issuedWarning")} />
                    <Descriptions column={1} size="small" bordered>
                        <Descriptions.Item label={t("admin.keys.name")}>{issuedKey?.name}</Descriptions.Item>
                        <Descriptions.Item label={t("admin.keys.expiresAt")}>{issuedKey?.expiresAt ? `${formatDate(issuedKey.expiresAt)}（${remainingText(issuedKey.expiresAt, Date.now(), { never: t("admin.keys.never"), expired: t("admin.keys.expiredAlready"), soon: t("admin.keys.remainingSoon"), day: t("admin.keys.remainingDays"), hour: t("admin.keys.remainingHours"), minute: t("admin.keys.remainingMinutes") })}）` : t("admin.keys.never")}</Descriptions.Item>
                        <Descriptions.Item label="Key">
                            <Space.Compact className="w-full">
                                <Input readOnly value={issuedKey?.key} className="!font-mono !text-xs" />
                                <Button icon={<Copy className="size-3.5" />} onClick={() => { void navigator.clipboard.writeText(issuedKey?.key || "").then(() => message.success(t("admin.keys.copied"))); }} />
                            </Space.Compact>
                        </Descriptions.Item>
                    </Descriptions>
                    <Button type="primary" block onClick={() => setIssuedKey(null)}>{t("admin.keys.issuedDone")}</Button>
                </div>
            </Modal>

            {/* 托管渠道编辑 */}
            <Drawer open={Boolean(channelEditor)} width={480} title={t("admin.channels.editorTitle")} onClose={() => setChannelEditor(null)} extra={<Button type="primary" onClick={() => void saveChannel()}>{t("common.save")}</Button>}>
                {channelEditor ? (
                    <div className="space-y-3">
                        <label className="block">
                            <span className="mb-1 block text-sm font-medium">{t("admin.channels.name")}</span>
                            <Input value={channelEditor.name || ""} onChange={(e) => setChannelEditor({ ...channelEditor, name: e.target.value })} />
                        </label>
                        <label className="block">
                            <span className="mb-1 block text-sm font-medium">{t("admin.channels.baseUrl")}</span>
                            <Input value={channelEditor.baseUrl || ""} onChange={(e) => setChannelEditor({ ...channelEditor, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
                        </label>
                        <label className="block">
                            <span className="mb-1 block text-sm font-medium">{t("admin.channels.apiKey")}</span>
                            <Input.Password value={channelEditor.apiKey || ""} onChange={(e) => setChannelEditor({ ...channelEditor, apiKey: e.target.value })} placeholder="sk-..." autoComplete="new-password" />
                            <span className="mt-1 block text-xs text-stone-500">{t("admin.channels.apiKeyHint")}</span>
                        </label>
                        <div className="flex flex-wrap items-center gap-2">
                            <Button size="small" icon={<RefreshCw className={fetchingModels ? "size-3.5 animate-spin" : "size-3.5"} />} loading={fetchingModels} onClick={() => void fetchUpstreamModels()}>{t("admin.channels.fetchModels")}</Button>
                            <span className="text-xs text-stone-500">{t("admin.channels.fetchHint")}</span>
                        </div>
                        {fetchedModels.length > 0 ? (
                            <Select
                                mode="multiple"
                                showSearch
                                allowClear
                                className="!w-full"
                                placeholder={t("admin.channels.pickModels")}
                                value={pickedFetched}
                                options={fetchedModels.map((name) => ({ label: name, value: name }))}
                                onChange={(selected) => applyPickedModels(selected)}
                            />
                        ) : null}
                        <label className="block">
                            <span className="mb-1 block text-sm font-medium">{t("admin.channels.models")}</span>
                            <span className="mb-2 block text-xs text-stone-500">{t("admin.channels.modelsHint")}</span>
                            <span className="mb-2 block text-xs text-amber-600 dark:text-amber-400">{t("admin.channels.managedProtocolHint")}</span>
                            <div className="space-y-2">
                                {(channelEditor.models || []).length === 0 ? (
                                    <div className="rounded-lg border border-dashed border-stone-300 px-3 py-2 text-xs text-stone-500 dark:border-stone-700">{t("admin.channels.modelsEmpty")}</div>
                                ) : null}
                                {(channelEditor.models || []).map((entry, index) => (
                                    <div key={index} className="flex flex-wrap items-center gap-2">
                                        <Input
                                            className="w-32 shrink-0"
                                            value={entry.alias || ""}
                                            placeholder={t("admin.channels.aliasPlaceholder")}
                                            title={t("admin.channels.aliasTitle")}
                                            onChange={(e) => setChannelEditor({ ...channelEditor, models: (channelEditor.models || []).map((x, i) => (i === index ? { ...x, alias: e.target.value } : x)) })}
                                        />
                                        <Input
                                            className="min-w-36 flex-1"
                                            value={entry.model}
                                            placeholder="doubao-seedream-5-0-pro-260628"
                                            onChange={(e) => setChannelEditor({ ...channelEditor, models: (channelEditor.models || []).map((x, i) => (i === index ? { ...x, model: e.target.value } : x)) })}
                                        />
                                        <Select
                                            value={entry.capability || "text"}
                                            style={{ width: 92 }}
                                            options={channelCapabilityOptions}
                                            onChange={(v) => setChannelEditor({ ...channelEditor, models: (channelEditor.models || []).map((x, i) => (i === index ? { ...x, capability: v, protocol: "auto" } : x)) })}
                                        />
                                        <Select
                                            value={entry.protocol || "auto"}
                                            style={{ width: 170 }}
                                            options={channelProtocolOptions(entry.capability)}
                                            onChange={(v) => setChannelEditor({ ...channelEditor, models: (channelEditor.models || []).map((x, i) => (i === index ? { ...x, protocol: v } : x)) })}
                                        />
                                        <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => setChannelEditor({ ...channelEditor, models: (channelEditor.models || []).filter((_, i) => i !== index) })} />
                                    </div>
                                ))}
                            </div>
                            <Button
                                className="mt-2"
                                size="small"
                                icon={<Plus className="size-3.5" />}
                                onClick={() => setChannelEditor({ ...channelEditor, models: [...(channelEditor.models || []), { model: "", capability: "text", protocol: "auto", alias: "" }] })}
                            >
                                {t("admin.channels.addModel")}
                            </Button>
                        </label>
                    </div>
                ) : null}
            </Drawer>
            {/* 长字段明文查看：apiKey / baseUrl 点击遮罩串后弹出，附一键复制。 */}
            <Modal open={Boolean(secretViewer)} title={secretViewer?.title} onCancel={() => setSecretViewer(null)} footer={null} width={640} centered>
                {secretViewer ? (
                    <div className="space-y-3">
                        <Input.TextArea readOnly value={secretViewer.value} autoSize={{ minRows: 2, maxRows: 8 }} className="font-mono !text-xs" />
                        <div className="flex justify-end gap-2">
                            <Button icon={<Copy className="size-3.5" />} onClick={() => { navigator.clipboard.writeText(secretViewer.value).then(() => message.success(t("common.copied"))).catch(() => message.error(t("common.copyFailed"))); }}>{t("common.copy")}</Button>
                            <Button type="primary" onClick={() => setSecretViewer(null)}>{t("common.close")}</Button>
                        </div>
                    </div>
                ) : null}
            </Modal>
        </main>
    );
}
