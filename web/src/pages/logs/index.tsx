import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Drawer, Empty, Input, Pagination, Segmented, Spin, Switch, Tag } from "antd";
import { Activity, CircleAlert, FileClock, RefreshCw, Search, Server } from "lucide-react";

import { getRequestLogs, getRuntimeLogs, LogApiError, type LogError, type RequestLog, type RequestLogsResponse, type RuntimeLog, type RuntimeLogsResponse } from "@/services/api/logs";

type LogKind = "requests" | "runtime";
type Selection = { kind: "requests"; item: RequestLog } | { kind: "runtime"; item: RuntimeLog };
type LogSnapshot = { key: string; updatedAt: string; requests?: RequestLogsResponse; runtime?: RuntimeLogsResponse };

const states = {
    pending: { label: "等待响应", color: "default" },
    streaming: { label: "传输中", color: "processing" },
    success: { label: "成功", color: "success" },
    error: { label: "错误", color: "error" },
    cancelled: { label: "已取消", color: "warning" },
};
const priorities: Record<string, string> = { "0": "紧急", "1": "警报", "2": "严重", "3": "错误", "4": "警告", "5": "通知", "6": "信息", "7": "调试" };

function formatTime(value?: string, microseconds = false) {
    if (!value) return "—";
    const date = new Date(microseconds ? Number(value) / 1000 : value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function ErrorDetails({ error }: { error?: LogError }) {
    return (
        <dl className="grid gap-3 text-sm sm:grid-cols-[100px_minmax(0,1fr)]">
            <dt className="text-stone-500 dark:text-stone-400">code</dt>
            <dd className="break-all font-mono">{error?.code || "—"}</dd>
            <dt className="text-stone-500 dark:text-stone-400">message</dt>
            <dd className="whitespace-pre-wrap break-all">{error?.message || "—"}</dd>
            <dt className="text-stone-500 dark:text-stone-400">traceId</dt>
            <dd className="break-all font-mono">{error?.traceId || "—"}</dd>
        </dl>
    );
}

export default function LogsPage() {
    const [kind, setKind] = useState<LogKind>("requests");
    const [live, setLive] = useState(true);
    const [errorOnly, setErrorOnly] = useState(false);
    const [search, setSearch] = useState("");
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(false);
    const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
    const [error, setError] = useState<LogError>();
    const [selected, setSelected] = useState<Selection | null>(null);
    const activeRequest = useRef<Promise<void>>(Promise.resolve());
    const lastLoadKey = useRef("");
    const requestQuery = kind === "requests" ? new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize), status: errorOnly ? "error" : "", q: keyword }).toString() : "";
    const key = `${kind}:${requestQuery}`;
    const data = snapshot?.key === key ? snapshot : null;
    const requests = data?.requests?.items || [];
    const runtime = (data?.runtime?.items || []).filter((item) => {
        const isError = /^[0-3]$/.test(item.priority);
        return (!errorOnly || isError) && (!keyword || `${item.service} ${item.priority} ${priorities[item.priority] || ""} ${item.message}`.toLowerCase().includes(keyword.toLowerCase()));
    }).slice().sort((a, b) => Number(b.time) - Number(a.time));
    const total = kind === "requests" ? data?.requests?.total || 0 : runtime.length;
    const visibleRuntime = runtime.slice((page - 1) * pageSize, page * pageSize);
    const runtimeError = data?.runtime?.error;
    const detail = selected?.kind === "requests" ? { ...selected, item: requests.find((item) => item.id === selected.item.id) || selected.item } : selected;

    useEffect(() => {
        const loadKey = `${key}:${refresh}`;
        const paused = !live && lastLoadKey.current === loadKey;
        lastLoadKey.current = loadKey;
        if (paused) {
            setLoading(false);
            return;
        }
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        const load = async () => {
            // 取消旧 fetch 后等待其退出，手动刷新与轮询共用一个请求槽。
            await activeRequest.current;
            if (disposed) return;
            setLoading(true);
            setError(undefined);
            const request = (async () => {
                try {
                    const result = kind === "requests"
                        ? { requests: await getRequestLogs(requestQuery, controller.signal) }
                        : { runtime: await getRuntimeLogs(controller.signal) };
                    if (!disposed) setSnapshot({ key, updatedAt: new Date().toISOString(), ...result });
                } catch (cause) {
                    if (!disposed && !controller.signal.aborted) {
                        setError(cause instanceof LogApiError ? cause.detail : { code: "LOG_FETCH_FAILED", message: cause instanceof Error ? cause.message : "读取日志失败", traceId: "" });
                    }
                } finally {
                    if (!disposed) setLoading(false);
                }
            })();
            activeRequest.current = request;
            await request;
            if (!disposed && live) timer = setTimeout(() => void load(), 3000);
        };
        void load();
        return () => {
            disposed = true;
            clearTimeout(timer);
            controller.abort();
        };
    }, [kind, requestQuery, key, refresh, live]);

    useEffect(() => {
        if (!data) return;
        setPage((current) => Math.min(current, Math.max(1, Math.ceil(total / pageSize))));
    }, [data, total, pageSize]);

    const changeKind = (value: LogKind) => {
        setKind(value);
        setPage(1);
        setSelected(null);
    };
    const submitSearch = (value: string) => {
        setKeyword(value.trim());
        setPage(1);
        setSelected(null);
    };
    const tableHead = (labels: string[]) => (
        <thead className="bg-stone-100/70 text-stone-500 dark:bg-stone-900/60 dark:text-stone-400">
            <tr>{labels.map((label) => <th key={label} className="px-4 py-3 text-left text-xs font-medium">{label}</th>)}</tr>
        </thead>
    );
    const cell = "px-4 py-3 align-top";
    const detailButton = (selection: Selection) => <Button type="text" size="small" onClick={() => setSelected(selection)}>详情</Button>;
    let fields: [string, ReactNode][] = [];
    if (detail?.kind === "requests") {
        const item = detail.item;
        fields = [["请求 ID", item.id], ["开始时间", formatTime(item.time)], ["方法", item.method], ["目标", item.target], ["模型", item.model || "—"], ["状态", states[item.state].label], ["HTTP 状态", item.status ?? "—"], ["耗时", `${item.durationMs} ms`], ["收到响应头", formatTime(item.headersAt)], ["结束时间", formatTime(item.endedAt)]];
    } else if (detail) {
        fields = [["服务", detail.item.service], ["时间", formatTime(detail.item.time, true)], ["级别", `${detail.item.priority} · ${priorities[detail.item.priority] || "未知"}`], ["message", detail.item.message]];
    }

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400"><Activity className="size-4" />运行观测</p>
                        <h1 className="mt-3 flex items-center gap-3 text-3xl font-semibold"><FileClock className="size-7" />日志</h1>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 text-sm"><Switch checked={live} onChange={setLive} aria-label="每 3 秒实时刷新" />实时（3 秒）</label>
                        <Button icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} disabled={loading} onClick={() => setRefresh((value) => value + 1)}>刷新</Button>
                    </div>
                </header>

                <p className="flex items-start gap-2 text-sm leading-6 text-stone-500 dark:text-stone-400">
                    <CircleAlert className="mt-1 size-4 shrink-0" />
                    <span>范围仅包含经本项目代理转发的请求，以及 infinite-canvas-web、infinite-canvas-proxy 两个项目服务的日志；不包含浏览器直连请求。请求日志最多保留最近 500 条，服务日志展示最近 100 条。</span>
                </p>

                <section className="flex flex-wrap items-center justify-between gap-4" aria-label="日志筛选">
                    <Segmented<LogKind> value={kind} onChange={changeKind} options={[
                        { value: "requests", label: "请求日志", icon: <Activity className="inline size-4" /> },
                        { value: "runtime", label: "服务日志", icon: <Server className="inline size-4" /> },
                    ]} />
                    <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 text-sm"><Switch checked={errorOnly} aria-label="仅看错误" onChange={(value) => { setErrorOnly(value); setPage(1); setSelected(null); }} />仅看错误</label>
                        <Input.Search className="w-full sm:!w-80" prefix={<Search className="size-4 text-stone-400" />} aria-label="搜索日志" placeholder={kind === "requests" ? "搜索目标、模型、code、traceId…" : "搜索服务、级别或消息…"} value={search} allowClear onChange={(event) => { setSearch(event.target.value); if (!event.target.value) submitSearch(""); }} onSearch={submitSearch} />
                    </div>
                </section>

                {error ? <Alert type="error" showIcon title="日志读取失败" description={<div className="space-y-3"><ErrorDetails error={error} /><p>请确认 /canvas-api 同源代理与日志接口可用。{data ? "下方保留上次成功读取的数据。" : ""}</p></div>} /> : null}
                {runtimeError ? <Alert type="warning" showIcon title="服务日志读取不完整或不可用" description={<div className="space-y-3"><ErrorDetails error={runtimeError} /><p>服务日志依赖服务器的 journalctl 及对应服务的读取权限。</p></div>} /> : null}

                <section className="min-w-0" aria-label={kind === "requests" ? "请求日志列表" : "服务日志列表"} aria-busy={loading}>
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span>{kind === "requests" ? "按请求开始时间倒序；错误筛选包含取消与 HTTP 4xx/5xx" : "按日志时间倒序；错误筛选为 priority 0–3"}</span>
                        <span>{loading ? "正在读取…" : live ? "实时刷新已开启" : "实时刷新已暂停"}{data ? ` · 更新于 ${formatTime(data.updatedAt)}` : ""}</span>
                    </div>
                    <Spin spinning={loading && !data}>
                        <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
                            {total ? (
                                <table className="w-full min-w-[960px] text-sm">
                                    {kind === "requests" ? tableHead(["时间", "请求", "模型", "状态 / HTTP", "耗时", "错误摘要", "操作"]) : tableHead(["时间", "服务", "级别", "消息", "操作"])}
                                    <tbody className="divide-y divide-stone-200 dark:divide-stone-800">
                                        {kind === "requests" ? requests.map((item) => (
                                            <tr key={item.id} className="hover:bg-stone-100/60 dark:hover:bg-stone-900/50">
                                                <td className={`${cell} whitespace-nowrap text-xs text-stone-500 dark:text-stone-400`}>{formatTime(item.time)}</td>
                                                <td className={`${cell} max-w-80`}><span className="font-mono text-xs">{item.method}</span><div className="mt-1 break-all text-xs">{item.target}</div></td>
                                                <td className={`${cell} max-w-40 break-all text-xs`}>{item.model || "—"}</td>
                                                <td className={`${cell} whitespace-nowrap`}><Tag color={states[item.state].color}>{states[item.state].label}</Tag><span className="text-xs">{item.status ?? "—"}</span></td>
                                                <td className={`${cell} whitespace-nowrap font-mono text-xs`}>{item.durationMs} ms</td>
                                                <td className={`${cell} max-w-72`}><div className="break-all font-mono text-xs">{item.error?.code || "—"}</div><p className="mt-1 line-clamp-2 break-all text-xs text-stone-500 dark:text-stone-400">{item.error?.message}</p></td>
                                                <td className={cell}>{detailButton({ kind: "requests", item })}</td>
                                            </tr>
                                        )) : visibleRuntime.map((item, index) => (
                                            <tr key={`${item.service}:${item.time}:${index}`} className="hover:bg-stone-100/60 dark:hover:bg-stone-900/50">
                                                <td className={`${cell} whitespace-nowrap text-xs text-stone-500 dark:text-stone-400`}>{formatTime(item.time, true)}</td>
                                                <td className={`${cell} font-mono text-xs`}>{item.service}</td>
                                                <td className={`${cell} whitespace-nowrap`}><Tag color={/^[0-3]$/.test(item.priority) ? "error" : item.priority === "4" ? "warning" : "default"}>{priorities[item.priority] || item.priority}</Tag></td>
                                                <td className={`${cell} max-w-xl`}><p className="line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs">{item.message}</p></td>
                                                <td className={cell}>{detailButton({ kind: "runtime", item })}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            ) : <div className="py-16"><Empty description={loading ? "正在读取日志" : error ? "暂时无法获取日志" : keyword || errorOnly ? "没有匹配的日志" : "暂无日志"} /></div>}
                        </div>
                    </Spin>
                    <div className="mt-4 flex justify-end">
                        <Pagination current={page} pageSize={pageSize} total={total} showSizeChanger pageSizeOptions={[10, 20, 50, 100]} showTotal={(count) => `共 ${count} 条`} onChange={(nextPage, nextSize) => { setPage(nextSize === pageSize ? nextPage : 1); setPageSize(nextSize); setSelected(null); }} />
                    </div>
                </section>
            </div>
            <Drawer title={detail?.kind === "runtime" ? "服务日志详情" : "请求日志详情"} open={Boolean(detail)} onClose={() => setSelected(null)} size="large">
                <div className="space-y-6 text-stone-950 dark:text-stone-100">
                    <dl className="grid gap-3 text-sm sm:grid-cols-[100px_minmax(0,1fr)]">
                        {fields.map(([label, value]) => <div key={label} className="contents"><dt className="text-stone-500 dark:text-stone-400">{label}</dt><dd className="whitespace-pre-wrap break-all">{value}</dd></div>)}
                    </dl>
                    {detail?.kind === "requests" ? <section className="border-t border-stone-200 pt-5 dark:border-stone-800"><h2 className="mb-4 text-sm font-medium">错误详情</h2><ErrorDetails error={detail.item.error} /></section> : null}
                </div>
            </Drawer>
        </main>
    );
}
