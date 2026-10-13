export type LogError = { code: string; message: string; traceId: string };

export type RequestLog = {
    id: string;
    time: string;
    method: string;
    target: string;
    status: number | null;
    durationMs: number;
    state: "pending" | "streaming" | "success" | "error" | "cancelled";
    model: string;
    headersAt?: string;
    endedAt?: string;
    error?: LogError;
};

export type RequestLogsResponse = { items: RequestLog[]; total: number };
export type RuntimeLog = { service: string; time: string; priority: string; message: string };
export type RuntimeLogsResponse = { services: string[]; scope: string; items: RuntimeLog[]; total: number; error?: LogError };

export class LogApiError extends Error {
    constructor(public detail: LogError) {
        super(detail.message);
    }
}

async function fetchLogs<T extends { items: unknown[]; total: number }>(path: string, signal: AbortSignal): Promise<T> {
    const response = await fetch(`/canvas-api/${path}`, { signal, cache: "no-store" });
    let data;
    try {
        data = await response.json();
    } catch (error) {
        if (signal.aborted) throw error;
        throw new LogApiError({ code: `HTTP_${response.status}`, message: "日志接口未返回 JSON，请确认同源代理已启用且日志接口可用。", traceId: "" });
    }
    if (!response.ok) {
        const error = data?.error;
        throw new LogApiError({
            code: error?.code || `HTTP_${response.status}`,
            message: typeof error === "string" ? error : error?.message || `读取日志失败（HTTP ${response.status}）`,
            traceId: error?.traceId || "",
        });
    }
    if (!Array.isArray(data?.items) || typeof data.total !== "number") {
        throw new LogApiError({ code: "INVALID_LOG_RESPONSE", message: "日志接口响应格式不正确。", traceId: "" });
    }
    return data as T;
}

export function getRequestLogs(query: string, signal: AbortSignal) {
    return fetchLogs<RequestLogsResponse>(`__logs?${query}`, signal);
}

export function getRuntimeLogs(signal: AbortSignal) {
    return fetchLogs<RuntimeLogsResponse>("__runtime", signal);
}
