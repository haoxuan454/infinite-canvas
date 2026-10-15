// 管理后台（/admin）：访问 Key 签发与吊销 / 设备指纹台账 / 托管上游渠道 / 自定义渠道上报（不可变）/ 审计。
// 设计语言：Linear/Supabase 式数据密集仪表盘（参考 VoltAgent/awesome-design-md），layui 式后台组件形态，
// quark 式轻盈动效；密钥与指纹一律等宽字体；状态使用带圆点的胶囊 Tag。
import { Alert, App, Button, Card, Descriptions, Drawer, Empty, Input, InputNumber, Modal, Popconfirm, Radio, Segmented, Space, Table, Tabs, Tag, Typography } from "antd";
import { Activity, CheckCircle2, Copy, Fingerprint, KeyRound, Link2, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type AccessKey = { key: string; keyMasked: string; name: string; createdAt: number; expiresAt: number | null; maxDevices: number; revokedAt: number | null; note: string; deviceCount: number };
type Device = { id: string; key: string; fingerprint: string; ip: string; userAgent: string; firstSeen: number; lastSeen: number; blockedAt: number | null };
type Channel = { id: string; name: string; baseUrl: string; apiKey: string; models: string[]; createdAt: number; source: string };
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

const EXPIRY_PRESETS = [
    { value: 7, label: "7天" },
    { value: 30, label: "30天" },
    { value: 90, label: "90天" },
    { value: 365, label: "1年" },
    { value: 0, label: "永久" },
];

export default function AdminPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
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
    const [issueForm, setIssueForm] = useState({ name: "", expiryDays: 30, maxDevices: 1, note: "" });
    const issueKey = async () => {
        if (!issueForm.name.trim()) { message.warning(t("admin.keys.nameRequired")); return; }
        const expiresAt = issueForm.expiryDays > 0 ? Date.now() + issueForm.expiryDays * 86_400_000 : null;
        const data = await adminFetch<{ key: AccessKey }>("/keys", { method: "POST", body: JSON.stringify({ name: issueForm.name.trim(), expiresAt, maxDevices: issueForm.maxDevices, note: issueForm.note }) });
        setIssuedKey(data.key);
        setIssueOpen(false);
        setIssueForm({ name: "", expiryDays: 30, maxDevices: 1, note: "" });
        await refreshAll();
    };

    const revokeKey = (key: string) => adminFetch(`/keys/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ revoke: true }) }).then(refreshAll).catch((e) => message.error(e.message));
    const deleteKey = (key: string) => adminFetch(`/keys/${encodeURIComponent(key)}`, { method: "DELETE" }).then(refreshAll).catch((e) => message.error(e.message));
    const extendKey = (key: string, days: number) => adminFetch(`/keys/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ expiresAt: Date.now() + days * 86_400_000 }) }).then(() => { message.success(t("admin.keys.extended")); return refreshAll(); }).catch((e) => message.error(e.message));

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
                                            { title: t("admin.keys.expiresAt"), dataIndex: "expiresAt", width: 150, render: (v: number | null) => <span className="font-mono text-xs">{v ? formatDate(v) : t("admin.keys.never")}</span> },
                                            { title: t("admin.keys.lastSeen"), width: 90, render: (_: unknown, k: AccessKey) => { const ds = devices.filter((d) => d.key === k.key); const latest = ds.length ? Math.max(...ds.map((d) => d.lastSeen)) : 0; return <span className="font-mono text-xs text-stone-500">{latest ? relativeTime(latest) : "-"}</span>; } },
                                            {
                                                title: t("admin.keys.actions"),
                                                width: 220,
                                                render: (_: unknown, k: AccessKey) => (
                                                    <Space size={4}>
                                                        {!k.revokedAt ? <Button size="small" onClick={() => void extendKey(k.key, 30)}>{t("admin.keys.extend")}</Button> : null}
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
                                    <Segmented
                                        value={deviceKeyFilter}
                                        onChange={(v) => setDeviceKeyFilter(v as string)}
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
                                            { title: t("admin.channels.baseUrl"), dataIndex: "baseUrl", render: (v: string) => <span className="font-mono text-xs">{v}</span> },
                                            { title: t("admin.channels.apiKey"), dataIndex: "apiKey", render: (v: string) => <Space size={0}><span className="font-mono text-xs">{v}</span><CopyButton text={v} /></Space> },
                                            { title: t("admin.channels.models"), dataIndex: "models", render: (v: string[]) => <span className="text-xs text-stone-500">{v?.join("、") || "-"}</span> },
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
                                            { title: t("admin.reports.baseUrl"), dataIndex: "baseUrl", render: (v: string) => <span className="font-mono text-xs">{v}</span> },
                                            { title: t("admin.reports.apiKey"), dataIndex: "apiKey", render: (v: string) => <Space size={0}><span className="font-mono text-xs text-rose-600 dark:text-rose-400">{v}</span><CopyButton text={v} /></Space> },
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
                        <Radio.Group value={issueForm.expiryDays} onChange={(e) => setIssueForm({ ...issueForm, expiryDays: e.target.value })} optionType="button" buttonStyle="solid" options={EXPIRY_PRESETS} />
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

            {/* 签发结果：唯一一次展示完整 Key */}
            <Modal open={Boolean(issuedKey)} footer={null} onCancel={() => setIssuedKey(null)} title={<span className="inline-flex items-center gap-2"><CheckCircle2 className="size-4 text-emerald-500" />{t("admin.keys.issuedTitle")}</span>}>
                <div className="space-y-3 pt-2">
                    <Alert type="warning" showIcon message={t("admin.keys.issuedWarning")} />
                    <Descriptions column={1} size="small" bordered>
                        <Descriptions.Item label={t("admin.keys.name")}>{issuedKey?.name}</Descriptions.Item>
                        <Descriptions.Item label={t("admin.keys.expiresAt")}>{issuedKey?.expiresAt ? formatDate(issuedKey.expiresAt) : t("admin.keys.never")}</Descriptions.Item>
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
                        <label className="block">
                            <span className="mb-1 block text-sm font-medium">{t("admin.channels.models")}</span>
                            <Input.TextArea rows={3} value={(channelEditor.models || []).join("\n")} onChange={(e) => setChannelEditor({ ...channelEditor, models: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} placeholder={"gpt-image-2\ngrok-imagine-video"} />
                        </label>
                    </div>
                ) : null}
            </Drawer>
        </main>
    );
}
